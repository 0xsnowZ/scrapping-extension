// aubiplus_script.js
let isScraping = false;
let isPaused = false;
let targetLimit = 50;

const PORTAL_SOURCE = 'Aubi-Plus.de';

const finishedSound = new Audio(chrome.runtime.getURL('finished.mp3'));
let settings = { notifyFinish: true, autoExport: false, deepEmailLookup: true };
StorageHelper.get(["notifyFinish", "autoExport", "deepEmailLookup"]).then((res) => {
    if (res.notifyFinish !== undefined) settings.notifyFinish = res.notifyFinish !== false;
    if (res.autoExport !== undefined) settings.autoExport = res.autoExport === true;
    settings.deepEmailLookup = true;
});

// waitForElement() provided by utils.js (MutationObserver-based, loaded first via manifest.json)

async function applyFilters() {
    // Check and wait for the filter dropdown
    const dropdownBtn = await waitForElement('.btn-filter', 5000);
    if (dropdownBtn) {
        dropdownBtn.click();

        // The checkbox is hidden (d-none), so we click its label instead
        const ausbildungCheckbox = await waitForElement('#fTyp_ausbildung', 3000);
        const ausbildungLabel = document.querySelector('label[for="fTyp_ausbildung"]');
        if (ausbildungCheckbox && ausbildungLabel) {
            if (!ausbildungCheckbox.checked) {
                ausbildungLabel.click();
                await sleep(800);
            }
        }
    }
}

async function handleSearchPage(limit = 50) {
    if (isScraping) return;
    isScraping = true;
    isPaused = false;
    targetLimit = limit;

    await applyFilters();

    // Give it a moment to ensure cards are loaded
    await sleep(1000);

    let currentData = await StorageHelper.get('scrapedData', []);

    // Build URL dedup set from existing data to avoid duplicates on re-runs
    const seenUrls = new Set(currentData.map(d => d.link).filter(Boolean));

    let keepGoing = true;
    let currentPage = 1;
    let emptyPageCount = 0;
    const MAX_EMPTY_PAGES = 10;

    let docToSearch = document;

    while (keepGoing && currentData.filter(d => d.source === PORTAL_SOURCE).length < targetLimit) {
        if (!isScraping) break;

        while (isPaused) {
            await sleep(500);
            if (!isScraping) break;
        }
        if (!isScraping) break;

        if (currentPage > 1) {
            // Recognize Aubi-Plus pagination button (exclude disabled buttons e.g. on final page)
            let nextBtn = docToSearch.querySelector('li.page-item:not(.disabled) a[rel="next"]') ||
                docToSearch.querySelector('li.page-item:not(.disabled) a.page-link[aria-label*="Next"]') ||
                docToSearch.querySelector('li.page-item:not(.disabled) a.page-link[aria-label*="Weiter"]') ||
                Array.from(docToSearch.querySelectorAll('ul.pagination li.page-item:not(.disabled) a.page-link')).find(a => (a.textContent || '').includes('»') || (a.textContent || '').includes('Weiter') || (a.textContent || '').includes('Nächste'));

            const rawHref = nextBtn ? (nextBtn.getAttribute('href') || '').trim() : '';
            if (!nextBtn || !rawHref || rawHref === '#' || rawHref.startsWith('javascript:')) {
                console.log("[AubiPlus] No next page button found or reached last page. Pagination ends.");
                break; // No more cards/pages found
            }

            try {
                let nextUrl = resolveHref(rawHref, 'https://www.aubi-plus.de');
                console.log("[AubiPlus] Fetching next page: ", nextUrl);
                const res = await fetchWithRetry(nextUrl);
                const text = await res.text();
                docToSearch = parseHtml(text);
            } catch (e) {
                console.error("[AubiPlus] Error fetching next page", e);
                break;
            }
        }

        const cards = docToSearch.querySelectorAll('.my-3.text-primary-dark.overflow-hidden.rounded-3');
        if (cards.length === 0) {
            console.log("No cards found on this page.");
            break; // No more cards found on this page
        }

        // Collect all card URLs first, then process in parallel batches
        const cardUrls = [];
        for (let i = 0; i < cards.length; i++) {
            let linkElement = cards[i].querySelector('a.stretched-link') || cards[i].querySelector('h2 a') || cards[i].querySelector('a:not([href="#"])');
            if (cards[i].tagName === 'A') linkElement = cards[i];
            if (!linkElement) continue;

            let href = linkElement.href || linkElement.getAttribute('href');
            if (!href) continue;

            // Resolve URLs from DOMParser (may have chrome-extension:// prefix)
            href = resolveHref(linkElement.getAttribute('href') || href, 'https://www.aubi-plus.de');

            if (!seenUrls.has(href)) {
                seenUrls.add(href);
                cardUrls.push(href);
            }
        }

        if (cardUrls.length === 0) {
            emptyPageCount++;
            if (emptyPageCount >= MAX_EMPTY_PAGES) {
                console.log(`[AubiPlus] No new cards after ${MAX_EMPTY_PAGES} pages. Ending.`);
                break;
            }
            currentPage++;
            continue;
        }
        emptyPageCount = 0;

        // Process in parallel batches of 5 for ~5x speed improvement
        const BATCH_SIZE = 5;
        for (let i = 0; i < cardUrls.length; i += BATCH_SIZE) {
            while (isPaused) {
                await sleep(500);
                if (!isScraping) break;
            }
            if (!isScraping) break;
            if (currentData.filter(d => d.source === PORTAL_SOURCE).length >= targetLimit) break;

            const batch = cardUrls.slice(i, i + BATCH_SIZE);
            const results = await Promise.allSettled(batch.map(async (href) => {
                try {
                    const response = await fetchWithRetry(href);
                    const text = await response.text();
                    const doc = parseHtml(text);

                    // Aubi-Plus encodes script type as "application&#x2F;ld&#x2B;json"
                    // which breaks querySelector, so extract hiringOrganization.name via regex
                    const companyName = (() => {
                        const orgMatch = text.match(/"hiringOrganization"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/);
                        if (orgMatch) return orgMatch[1].replace(/\\u[\da-fA-F]{4}/g, m => String.fromCharCode(parseInt(m.slice(2), 16)));
                        return extractCompanyFromDoc(doc);
                    })() ||
                        (() => {
                            const el = doc.querySelector('.fs-6.mb-0.lh-1');
                            return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
                        })();

                    const address = (() => {
                        // Regex extraction from JSON-LD (same encoding issue as company)
                        const street = (text.match(/"streetAddress"\s*:\s*"([^"]+)"/) || [])[1] || '';
                        const postal = (text.match(/"postalCode"\s*:\s*"([^"]+)"/) || [])[1] || '';
                        const locality = (text.match(/"addressLocality"\s*:\s*"([^"]+)"/) || [])[1] || '';
                        if (street || postal || locality) {
                            const decoded = [street, postal, locality].filter(Boolean).join(', ')
                                .replace(/\\u[\da-fA-F]{4}/g, m => String.fromCharCode(parseInt(m.slice(2), 16)));
                            return decoded;
                        }
                        return extractAddressFromDoc(doc);
                    })() ||
                        (() => {
                            const icons = doc.querySelectorAll('.fa-location-dot');
                            for (let icon of icons) {
                                if (icon.nextElementSibling && icon.nextElementSibling.tagName === 'SPAN') {
                                    return icon.nextElementSibling.textContent.trim();
                                }
                            }
                            return '';
                        })();

                    let email = extractEmailFromHtml(text);
                    const website = await resolveCompanyWebsite(doc, 'aubi-plus.de');
                    const phone = (() => {
                            const el = doc.querySelector('.phoneNumber');
                            return el ? el.textContent.trim() : '';
                        })() || extractPhoneFromHtml(text);

                    // Extract Ansprechpartner: "Frau Claudia Pelka" in <strong> near mail-protect
                    const contact = (() => {
                        const contactMatch = text.match(/<strong>\s*((?:Frau|Herr)\s+[^<]+?)\s*<\/strong>/i);
                        if (contactMatch) return contactMatch[1].trim();
                        // Fallback: alt attribute of ansprechpartner image
                        const altMatch = text.match(/ansprechpartner[^>]*alt="([^"]+)"/i);
                        if (altMatch) return altMatch[1].trim();
                        return '';
                    })();

                    return { href, companyName, address, email, phone, contact, website };
                } catch (err) {
                    console.error("Error fetching details", err);
                    return null;
                }
            }));

            // Process batch results
            for (const result of results) {
                if (result.status !== 'fulfilled' || !result.value) continue;
                if (currentData.filter(d => d.source === PORTAL_SOURCE).length >= targetLimit) break;

                const { href, companyName, address, phone, contact, website } = result.value;
                let email = result.value.email;

                // Deep Email Lookup fallback if no direct email is in the job card
                if (!email && settings.deepEmailLookup && website) {
                    console.log(`[AubiPlus] No direct email for ${href}, attempting Deep Email Lookup on: ${website}`);
                    try {
                        email = await crawlWebsiteForEmailWithTimeout(website, 5000);
                        if (email) {
                            console.log(`[AubiPlus] ✓ Deep Lookup found email: ${email} (${website})`);
                        }
                    } catch (e) {
                        console.warn(`[AubiPlus] Deep Lookup error for ${website}:`, e);
                    }
                }

                if (!email) {
                    safeSendMessage({ action: 'progress', count: currentData.length, portalCount: currentData.filter(d => d.source === PORTAL_SOURCE).length, currentTitle: `Checking: ${companyName || 'Unknown'} (no email)` });
                    continue;
                }

                // Email dedup: skip if this email was already scraped
                if (isDuplicateEmail(currentData, email)) {
                    console.log("[AubiPlus] Duplicate email, skipping:", email);
                    continue;
                }

                seenUrls.add(href);
                currentData.push({
                    company: companyName,
                    email: email,
                    address: address,
                    contact: contact || '',
                    link: href,
                    website: website || '',
                    phone: phone,
                    source: PORTAL_SOURCE,
                    extractedAt: new Date().toISOString()
                });

                safeSendMessage({ action: 'progress', count: currentData.length, portalCount: currentData.filter(d => d.source === PORTAL_SOURCE).length, currentTitle: companyName });
            }

            // Save once per batch instead of per-item
            await StorageHelper.set('scrapedData', currentData);

            // Anti-bot delay between batches
            await sleep(200);
        }

        currentPage++;
    }

    if (isScraping) {
        if (settings.notifyFinish) playAudioSafely(finishedSound);
        const portalCount = currentData.filter(d => d.source === PORTAL_SOURCE).length;
        const autoExported = triggerAutoExport(currentData, settings);
        safeSendMessage({ action: 'finished', count: currentData.length, portalCount, totalChecked: seenUrls.size || portalCount, autoExported });
    }
    isScraping = false;
    isPaused = false;
    StorageHelper.setMultiple({ isScraping: false, isPaused: false });
}

// Wrap with error propagation
const _handleSearchPage = handleSearchPage;
handleSearchPage = async function(limit) {
    try {
        await _handleSearchPage(limit);
    } catch (err) {
        console.error('[AubiPlus] Scraping error:', err);
        isScraping = false;
        isPaused = false;
        StorageHelper.setMultiple({ isScraping: false, isPaused: false });
        safeSendMessage({ action: 'error', message: String(err) });
    }
};

async function countResults() {
    await applyFilters();
    const titleEl = await waitForElement('.mb-0.pe-5.pe-sm-0.text-md-center.suchmaschine-title', 5000) ||
        await waitForElement('.suchmaschine-title', 2000);
    if (titleEl) {
        const dangerSpan = titleEl.querySelector('.text-danger');
        if (dangerSpan) {
            const numText = dangerSpan.innerText.replace(/\D/g, '');
            const num = parseInt(numText, 10);
            return isNaN(num) ? 0 : num;
        }
    }
    return 0;
}

// ─── Message Listener ─────────────────────────────────────────────────────────
// Uses shared createScraperMessageHandler from utils.js to reduce boilerplate.
// Default handlers cover: pause, resume, stop, getInitialInfo, getData.
chrome.runtime.onMessage.addListener(
    createScraperMessageHandler(
        () => ({ isScraping, isPaused }),
        {
            onSettings: (s) => { settings = { ...s, deepEmailLookup: true }; },
            onUpdateLimit: (limit) => { targetLimit = limit; },
            onPause: () => { isPaused = true; },
            onResume: () => { isPaused = false; },
            onStop: () => { isScraping = false; isPaused = false; },
            start: (request, sendResponse) => {
                const limit = request.limit || 50;
                if (!isScraping) handleSearchPage(limit);
                sendResponse({ status: 'started' });
            },
            reset: (request, sendResponse) => {
                isScraping = false;
                isPaused = false;
                StorageHelper.set('scrapedData', []).then(() => sendResponse({ status: 'reset' }));
            },
            countResults: (request, sendResponse) => {
                countResults().then(total => sendResponse({ total }));
            },
        }
    )
);
