// ausbildung_script.js - Scraper for ausbildung.de
// PAGINATION STRATEGY: Direct in-memory URL pagination with fetchWithRetry.
// Server-rendered search pages return all job links reliably via SSR HTML.
// We fetch pages in the background without disruptive window.location.href reloads,
// eliminating Next.js hydration race conditions, tab flickering, and session loss.
// Fallback: If fetch has no links, checks live DOM and 'Mehr Ergebnisse laden' button.

let isScraping = false;
let isPaused = false;
let targetLimit = 50;

const PORTAL_SOURCE = 'Ausbildung.de';

const finishedSound = new Audio(chrome.runtime.getURL("finished.mp3"));
let settings = { notifyFinish: true, autoExport: false, deepEmailLookup: true };
chrome.storage.local.get(["notifyFinish", "autoExport"], (res) => {
  if (res.notifyFinish !== undefined) settings.notifyFinish = res.notifyFinish !== false;
  if (res.autoExport !== undefined) settings.autoExport = res.autoExport === true;
  settings.deepEmailLookup = true;
});

// sleep, extractEmailFromHtml, extractCompanyFromDoc, extractAddressFromDoc, waitForElement
// are provided by utils.js (loaded first via manifest.json)

// ─── Data Extraction Helpers ─────────────────────────────────────────────────

function extractJobLinksFromDoc(doc) {
  const links = new Set();
  if (!doc) return [];
  doc.querySelectorAll('a[href*="/stellen/"]').forEach((a) => {
    const href = a.getAttribute("href");
    if (!href) return;
    let url = href.startsWith("http")
      ? href
      : "https://www.ausbildung.de" + href;
    url = url.split("?")[0]; // strip tracking query params
    // Ensure it's a specific job listing, not the directory root
    if (url.includes("/stellen/") && !url.endsWith("/stellen/")) {
      links.add(url);
    }
  });
  return Array.from(links);
}

// Helper to find 'Mehr Ergebnisse laden' button on the live page
function findLoadMoreButton() {
  const explicit = document.querySelector(
    'button[data-testid*="load-more"], button[data-testid*="pagination-more"], button[class*="loadMore"], button[class*="LoadMore"]'
  );
  if (explicit && !explicit.disabled && explicit.offsetParent !== null) {
    return explicit;
  }

  const buttons = Array.from(document.querySelectorAll('button, a[role="button"], div[role="button"]'));
  for (const btn of buttons) {
    if (btn.disabled || btn.offsetParent === null) continue;
    const txt = (btn.textContent || '').trim().toLowerCase();
    if (
      txt.includes('mehr ergebnisse laden') ||
      txt.includes('weitere ergebnisse') ||
      txt.includes('mehr laden') ||
      txt.includes('weitere anzeigen') ||
      txt.includes('weitere laden')
    ) {
      return btn;
    }
  }
  return null;
}

// ─── Persistent Session Helpers ───────────────────────────────────────────────

const STATE_KEY = "ausbildungScrapingSession";

function saveSession(session) {
  return StorageHelper.set({ [STATE_KEY]: session });
}

async function loadSession() {
  const res = await StorageHelper.get([STATE_KEY]);
  return res[STATE_KEY] || null;
}

function clearSession() {
  return StorageHelper.remove(STATE_KEY);
}

// ─── URL Builder ─────────────────────────────────────────────────────────────

function buildPageUrl(baseUrl, page) {
  const url = new URL(baseUrl);
  if (page > 1) {
    url.searchParams.set("page", page);
  } else {
    url.searchParams.delete("page");
  }
  return url.toString();
}

// ─── Core Scraping Engine ─────────────────────────────────────────────────────

async function runScraping(session) {
  const { baseUrl } = session;
  targetLimit = session.limit;
  let { currentData, page } = session;
  const processedLinks = new Set(session.processedLinks || []);
  let processedHits = session.processedHits || 0;
  let emptyPageCount = session.emptyPageCount || 0;
  let dryPageCount = session.dryPageCount || 0;
  const MAX_EMPTY_PAGES = 15;
  const MAX_DRY_PAGES = 20;

  while (isScraping && currentData.filter(d => d.source === PORTAL_SOURCE).length < targetLimit) {
    // ── Pause loop ──────────────────────────────────────────────────────────
    while (isPaused) {
      await sleep(500);
      if (!isScraping) return;
    }
    if (!isScraping) return;

    // ── Fetch search results page HTML or use live DOM for page 1 ───────────
    let pageDoc = null;
    let jobLinks = [];

    // If on page 1 and live DOM already has job links, use live DOM
    if (page === 1 && extractJobLinksFromDoc(document).length > 0) {
      pageDoc = document;
      jobLinks = extractJobLinksFromDoc(pageDoc).filter((l) => !processedLinks.has(l));
    }

    // If not page 1, or live DOM had no unvisited links, fetch via URL
    if (jobLinks.length === 0) {
      const pageUrl = buildPageUrl(baseUrl, page);
      console.log(`[Ausbildung] Fetching page ${page}: ${pageUrl}`);
      safeSendMessage({
        action: "progress",
        count: currentData.length,
        portalCount: currentData.filter(d => d.source === PORTAL_SOURCE).length,
        currentTitle: `Loading page ${page}...`,
      });

      try {
        const res = await fetchWithRetry(pageUrl, {
          credentials: "include",
          headers: {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          }
        });
        if (res.ok) {
          const html = await res.text();
          pageDoc = parseHtml(html);
          jobLinks = extractJobLinksFromDoc(pageDoc).filter((l) => !processedLinks.has(l));
        } else {
          console.warn(`[Ausbildung] Page fetch failed with status ${res.status}: ${pageUrl}`);
        }
      } catch (err) {
        console.error(`[Ausbildung] Error fetching page ${pageUrl}:`, err);
      }
    }

    // Fallback: If still no links, try checking live DOM or clicking 'Mehr Ergebnisse laden'
    if (jobLinks.length === 0) {
      const liveNewLinks = extractJobLinksFromDoc(document).filter((l) => !processedLinks.has(l));
      if (liveNewLinks.length > 0) {
        jobLinks = liveNewLinks;
      } else {
        const loadMoreBtn = findLoadMoreButton();
        if (loadMoreBtn) {
          console.log("[Ausbildung] Attempting to click 'Mehr Ergebnisse laden' button on live page...");
          loadMoreBtn.scrollIntoView({ behavior: "smooth", block: "center" });
          await sleep(300);
          loadMoreBtn.click();
          await sleep(2000);
          jobLinks = extractJobLinksFromDoc(document).filter((l) => !processedLinks.has(l));
        }
      }
    }

    console.log(`[Ausbildung] Page ${page}: ${jobLinks.length} new links found`);

    if (jobLinks.length === 0) {
      emptyPageCount++;
      console.log(`[Ausbildung] Empty page ${emptyPageCount}/${MAX_EMPTY_PAGES} on page ${page}`);
      if (emptyPageCount >= MAX_EMPTY_PAGES) {
        console.log("[Ausbildung] No more results found. Scraping complete.");
        break;
      }
      page++;
      await saveSession({
        limit: targetLimit,
        baseUrl,
        currentData,
        page,
        processedLinks: [...processedLinks],
        processedHits,
        dryPageCount,
        emptyPageCount
      });
      continue;
    }

    emptyPageCount = 0;

    // Track emails found on this page to detect dry pages
    const countBefore = currentData.length;

    for (const jobUrl of jobLinks) {
      if (!isScraping) return;
      if (isPaused) {
        await saveSession({
          limit: targetLimit,
          baseUrl,
          currentData,
          page,
          processedLinks: [...processedLinks],
          processedHits,
          dryPageCount,
          emptyPageCount
        });
        while (isPaused) {
          await sleep(500);
          if (!isScraping) return;
        }
      }
      if (currentData.filter(d => d.source === PORTAL_SOURCE).length >= targetLimit) break;

      processedLinks.add(jobUrl);
      processedHits++;

      safeSendMessage({
        action: "progress",
        count: currentData.length,
        portalCount: currentData.filter(d => d.source === PORTAL_SOURCE).length,
        currentTitle: `Job ${processedHits} · Page ${page}`,
      });

      try {
        const response = await fetchWithRetry(jobUrl, {
          credentials: "include",
          headers: { "Accept": "text/html,application/xhtml+xml" },
        });
        if (!response.ok) {
          console.warn(`[Ausbildung] Fetch failed (${response.status}): ${jobUrl}`);
          continue;
        }

        const html = await response.text();
        const doc = parseHtml(html);

        let email = extractEmailFromHtml(html);
        const website = await resolveCompanyWebsite(doc, "ausbildung.de");

        // Deep Email Lookup fallback if no direct email is in the job card
        if (!email && settings.deepEmailLookup && website) {
          console.log(`[Ausbildung] No direct email for ${jobUrl}, attempting Deep Email Lookup on: ${website}`);
          try {
            email = await crawlWebsiteForEmailWithTimeout(website, 5000);
            if (email) {
              console.log(`[Ausbildung] ✓ Deep Lookup found email: ${email} (${website})`);
            }
          } catch (e) {
            console.warn(`[Ausbildung] Deep Lookup error for ${website}:`, e);
          }
        }

        if (!email) continue;

        // Strict deduplication by normalized email
        if (isDuplicateEmail(currentData, email)) {
          console.log(`[Ausbildung] Skipping duplicate: ${email}`);
          continue;
        }

        let company = extractCompanyFromDoc(doc);

        // Fallback: use job title as company name when company can't be found
        if (!company) {
          const titleEl = doc.querySelector('h1') || doc.querySelector('title');
          if (titleEl) {
            let title = titleEl.textContent.trim();
            title = title.replace(/\s*[|–—-]\s*(ausbildung\.de|ausbildung).*$/i, '').trim();
            if (title && title.length < 120) company = title;
          }
        }

        const address = extractAddressFromDoc(doc);
        const phone = extractPhoneFromHtml(html);

        currentData.push({
          company: company || "Unknown",
          email,
          address,
          contact: "",
          link: jobUrl,
          website: website || "",
          phone,
          source: PORTAL_SOURCE,
          extractedAt: new Date().toISOString()
        });

        // Persist immediately
        await StorageHelper.set({ scrapedData: currentData });
        safeSendMessage({
          action: "progress",
          count: currentData.length,
          portalCount: currentData.filter(d => d.source === PORTAL_SOURCE).length,
          currentTitle: `✓ ${company}`,
        });
        console.log(`[Ausbildung] ✓ (${currentData.length}/${targetLimit}): ${company} <${email}>`);

      } catch (err) {
        console.error(`[Ausbildung] Error processing ${jobUrl}:`, err);
      }

      // Anti-bot jitter
      await sleep(Math.floor(Math.random() * 250) + 200);
    }

    if (currentData.filter(d => d.source === PORTAL_SOURCE).length >= targetLimit) break;

    // Check if this page was dry
    if (currentData.length === countBefore) {
      dryPageCount++;
      console.log(`[Ausbildung] Dry page ${dryPageCount}/${MAX_DRY_PAGES} (page ${page} had no emails)`);
      if (dryPageCount >= MAX_DRY_PAGES) {
        console.log(`[Ausbildung] Too many dry pages. Finishing with ${currentData.length} results.`);
        safeSendMessage({
          action: "progress",
          count: currentData.length,
          currentTitle: `Done — no more emails found`,
        });
        break;
      }
    } else {
      dryPageCount = 0;
    }

    // Move to next page in memory (no window.location.href reload!)
    page++;
    await saveSession({
      limit: targetLimit,
      baseUrl,
      currentData,
      page,
      processedLinks: [...processedLinks],
      processedHits,
      dryPageCount,
      emptyPageCount
    });
  }

  // ── Scraping complete (limit reached or no more pages) ────────────────────
  await clearSession();
  chrome.storage.local.set({ isScraping: false, isPaused: false });

  const wasRunning = isScraping;
  isScraping = false;
  isPaused = false;

  if (wasRunning) {
    if (settings.notifyFinish) playAudioSafely(finishedSound);
    const portalCount = currentData.filter(d => d.source === PORTAL_SOURCE).length;
    const autoExported = triggerAutoExport(currentData, settings);
    safeSendMessage({
      action: "finished",
      count: currentData.length,
      portalCount,
      totalChecked: processedHits || portalCount,
      early: dryPageCount >= MAX_DRY_PAGES,
      empty: emptyPageCount >= MAX_EMPTY_PAGES,
      autoExported,
    });
  }
}

// ─── Entry Point: Fresh Start ─────────────────────────────────────────────────

async function handleSearchPage(limit = 50) {
  if (isScraping) return;
  isScraping = true;
  isPaused = false;
  targetLimit = limit;
  chrome.storage.local.set({ isScraping: true, isPaused: false });

  // Wait briefly for live DOM to settle if newly opened
  if (extractJobLinksFromDoc(document).length === 0) {
    await waitForElement('a[href*="/stellen/"]', 3000);
  }

  const currentData = await StorageHelper.get(["scrapedData"]).then(
    (res) => res.scrapedData || [],
  );

  // Strip page param from URL to get canonical base search URL
  const baseUrl = (() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("page");
    return url.toString();
  })();

  const page = parseInt(new URL(window.location.href).searchParams.get("page") || "1", 10);

  const session = {
    limit,
    baseUrl,
    currentData,
    page,
    processedLinks: [],
    processedHits: 0,
    dryPageCount: 0,
    emptyPageCount: 0
  };
  await saveSession(session);

  try {
    await runScraping(session);
  } catch (err) {
    console.error("[Ausbildung] Fatal error:", err);
    isScraping = false;
    isPaused = false;
    await clearSession();
    StorageHelper.setMultiple({ isScraping: false, isPaused: false });
    safeSendMessage({ action: "error", message: String(err) });
  }
}

// ─── Auto-Resume on Page Load ─────────────────────────────────────────────────
// Only needed if the tab was manually refreshed while a scrape was running.
(async () => {
  await sleep(1500);

  const session = await loadSession();
  if (!session) return; // No active session

  console.log(`[Ausbildung] Auto-resuming session on page ${session.page}...`);
  isScraping = true;
  isPaused = false;
  StorageHelper.setMultiple({ isScraping: true, isPaused: false });

  safeSendMessage({
    action: "progress",
    count: session.currentData ? session.currentData.length : 0,
    currentTitle: `Resumed on page ${session.page}`,
  });

  try {
    await runScraping(session);
  } catch (err) {
    console.error("[Ausbildung] Resume error:", err);
    isScraping = false;
    isPaused = false;
    await clearSession();
    StorageHelper.setMultiple({ isScraping: false, isPaused: false });
  }
})();

// ─── Count Available Results ──────────────────────────────────────────────────
async function countResults() {
  await sleep(800);
  const headlineSelectors = [
    '[class*="headline"]',
    '[class*="result-count"]',
    '[class*="SearchResults"] h1',
    '[class*="SearchResults"] h2',
    '[data-testid="search-result-title"]',
    "h1",
    "h2",
  ];
  for (const sel of headlineSelectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = el.innerText || el.textContent || "";
    const match = text.match(/([\d.,]+)\s*(freie|Ausbildung|Stellen|Ergebnisse|results)/i);
    if (match) return parseInt(match[1].replace(/[.,]/g, ""), 10);
    const numMatch = text.match(/^([\d.,]+)/);
    if (numMatch) return parseInt(numMatch[1].replace(/[.,]/g, ""), 10);
  }
  return extractJobLinksFromDoc(document).length;
}

// ─── Message Listener ─────────────────────────────────────────────────────────
// Uses shared createScraperMessageHandler from utils.js to reduce boilerplate.
// Default handlers cover: pause, resume, getInitialInfo, getData.
chrome.runtime.onMessage.addListener(
  createScraperMessageHandler(
    () => ({ isScraping, isPaused }),
    {
      onSettings: (s) => { settings = { ...s, deepEmailLookup: true }; },
      onUpdateLimit: (limit) => {
        targetLimit = limit;
        // Also persist to session for page-reload resume
        loadSession().then(session => {
          if (session) { session.limit = limit; saveSession(session); }
        });
      },
      onPause: () => {
        isPaused = true;
        chrome.storage.local.set({ isPaused: true });
      },
      onResume: () => {
        isPaused = false;
        chrome.storage.local.set({ isPaused: false });
      },
      onStop: () => {
        isScraping = false;
        isPaused = false;
        clearSession();
        chrome.storage.local.set({ isScraping: false, isPaused: false });
      },
      start: (request, sendResponse) => {
        const limit = request.limit || 50;
        if (!isScraping) handleSearchPage(limit);
        sendResponse({ status: "started" });
      },
      reset: (request, sendResponse) => {
        isScraping = false;
        isPaused = false;
        clearSession();
        chrome.storage.local.set({ scrapedData: [], isScraping: false, isPaused: false }, () => sendResponse({ status: "reset" }));
      },
      countResults: (request, sendResponse) => {
        countResults().then((total) => sendResponse({ total }));
      },
    }
  )
);
