/**
 * utils.js — Shared utility module for AutoAzubi content scripts
 * Loaded before site-specific scripts via manifest.json content_scripts.
 * All functions are available as globals in the content script scope.
 */

// ─── Shared Parser & Entity Decoder ───────────────────────────────────────────────

const _sharedDomParser = typeof DOMParser !== "undefined" ? new DOMParser() : null;

/**
 * Parses raw HTML string into a Document using a shared DOMParser instance.
 * Avoids creating thousands of parser instances in memory during scraping loops.
 * @param {string} htmlStr - HTML markup to parse
 * @returns {Document} Parsed HTML document
 */
function parseHtml(htmlStr) {
  if (!_sharedDomParser) return null;
  return _sharedDomParser.parseFromString(htmlStr || "", "text/html");
}

const _sharedDecodeTextarea = typeof document !== "undefined" && typeof document.createElement === "function"
  ? document.createElement("textarea")
  : null;

/**
 * Decodes HTML entities (e.g. &amp;, &#109;, &quot;) using a single reusable element.
 * @param {string} str - String containing HTML entities
 * @returns {string} Decoded plain text
 */
function decodeHtmlEntities(str) {
  if (!str) return "";
  if (_sharedDecodeTextarea) {
    _sharedDecodeTextarea.innerHTML = str;
    return _sharedDecodeTextarea.value;
  }
  // Fallback for non-DOM environments (Node.js / service worker)
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

// ─── Safe Messaging & Audio ───────────────────────────────────────────────────────

/**
 * Safely sends a runtime message to popup/background, catching rejections when popup is closed.
 * @param {Object} message - Message payload
 * @returns {Promise<any>|undefined}
 */
function safeSendMessage(message) {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      return chrome.runtime.sendMessage(message).catch(() => {});
    }
  } catch (e) {
    // Runtime context invalidated or popup closed
  }
}

/**
 * Safely plays audio while silently catching browser autoplay restrictions.
 * @param {HTMLAudioElement} audio - Audio instance to play
 */
function playAudioSafely(audio) {
  if (audio && typeof audio.play === "function") {
    return audio.play().catch(() => {});
  }
}

// ─── Storage Helper ───────────────────────────────────────────────────────────────

/**
 * Clean Promise wrappers for chrome.storage.local operations.
 */
const StorageHelper = {
  get: (keys, defaultValue) =>
    new Promise((resolve) => {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        if (typeof keys === "string") {
          chrome.storage.local.get([keys], (res) => {
            resolve(res && res[keys] !== undefined ? res[keys] : defaultValue);
          });
        } else {
          chrome.storage.local.get(keys, (res) => resolve(res || {}));
        }
      } else {
        resolve(typeof keys === "string" ? defaultValue : {});
      }
    }),
  set: (keyOrObject, value) =>
    new Promise((resolve) => {
      const payload = typeof keyOrObject === "string" ? { [keyOrObject]: value } : keyOrObject;
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(payload, resolve);
      } else {
        resolve();
      }
    }),
  setMultiple: (obj) =>
    new Promise((resolve) => {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(obj, resolve);
      } else {
        resolve();
      }
    }),
  remove: (keys) =>
    new Promise((resolve) => {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove(keys, resolve);
      } else {
        resolve();
      }
    }),
};

// ─── Deduplication Helper ─────────────────────────────────────────────────────────

/**
 * Checks if an email address already exists in the given dataset (normalized, case-insensitive).
 * @param {Array<Object>} data - Array of lead items with .email
 * @param {string} email - Email address to check
 * @returns {boolean} True if duplicate
 */
function isDuplicateEmail(data, email) {
  if (!email || !data || data.length === 0) return false;
  const normalized = String(email).trim().toLowerCase();
  return data.some((d) => d && d.email && String(d.email).trim().toLowerCase() === normalized);
}

// ─── Sleep ───────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sleep with rate-limiting notification to the popup.
 * Sends a 'throttling' progress message so the user sees anti-bot delays are intentional.
 * Only notifies for delays >= 200ms — shorter pauses aren't perceptible as rate limiting.
 * @param {number} ms - Duration to sleep in milliseconds
 */
async function sleepWithThrottle(ms) {
  if (ms >= 200) {
    safeSendMessage({ action: 'progress', status: 'throttling', delay: ms });
  }
  return sleep(ms);
}

// ─── Email Extraction (9 strategies, most reliable → broadest) ───────────────────

function extractEmailFromHtml(rawHtml) {
  if (!rawHtml) return "";

  let email = "";

  // Strategy 1: href="mailto:..." on .mail anchor (DasÖrtliche-specific, but harmless elsewhere)
  const mailtoHref =
    rawHtml.match(/class="mail"[^>]*href="mailto:([^"?\s]+)"/i) ||
    rawHtml.match(/href="mailto:([^"?\s]+)"[^>]*class="mail"/i);
  if (mailtoHref) {
    email = mailtoHref[1].trim();
  }

  // Strategy 2: title="..." on .mail anchor
  if (!email) {
    const titleMatch =
      rawHtml.match(/class="mail"[^>]*title="([^"]+@[^"]+)"/i) ||
      rawHtml.match(/title="([^"]+@[^"]+)"[^>]*class="mail"/i);
    if (titleMatch) email = titleMatch[1].trim();
  }

  // Strategy 3: Generic mailto: anywhere (supports double, single, or no quotes)
  if (!email) {
    const genericMailto = rawHtml.match(/href=["']?mailto:([^"'?\s>]+)/i);
    if (genericMailto) email = genericMailto[1].trim();
  }

  // Strategy 4: data-email / data-mail attribute (common obfuscation)
  if (!email) {
    const dataEmail =
      rawHtml.match(/data-email="([^"]+)"/i) ||
      rawHtml.match(/data-mail="([^"]+)"/i);
    if (dataEmail) {
      email = dataEmail[1].trim();
      // Aubi-Plus obfuscation: "l###i###a###@###e###x###.###d###e"
      email = email.replace(/###/g, "");
      email = email
        .replace(/\(at\)/gi, "@")
        .replace(/\[at\]/gi, "@")
        .replace(/\s*at\s*/gi, "@");
      email = email
        .replace(/\(dot\)/gi, ".")
        .replace(/\[dot\]/gi, ".")
        .replace(/\s*dot\s*/gi, ".");
    }
  }

  // Strategy 5: onclick handlers with mailto
  if (!email) {
    const onclickMailto = rawHtml.match(
      /onclick="[^"]*mailto:([^"'\s?]+)/i,
    );
    if (onclickMailto) email = onclickMailto[1].trim();
  }

  // Strategy 6: HTML entity encoded emails (&#109;&#97;&#105;&#108;&#116;&#111;&#58;)
  if (!email) {
    const entityMatch = rawHtml.match(
      /href="&#109;&#97;&#105;&#108;&#116;&#111;&#58;([^"]+)"/i,
    );
    if (entityMatch) {
      email = decodeHtmlEntities(entityMatch[1]).trim();
    }
  }

  // Strategy 7: Obfuscated [at] / [AT] / [dot] / [DOT]
  if (!email) {
    const obfuscatedMatch = rawHtml.match(
      /[\w.\-]+\s*\[(?:at|AT)\]\s*[\w.\-]+\s*\[(?:dot|DOT)\]\s*[\w.\-]+/,
    );
    if (obfuscatedMatch) {
      email = obfuscatedMatch[0]
        .replace(/\s*\[(?:at|AT)\]\s*/g, "@")
        .replace(/\s*\[(?:dot|DOT)\]\s*/g, ".");
    }
  }

  // Strategy 8: (at) / (dot) parentheses
  if (!email) {
    const parenMatch = rawHtml.match(
      /[\w.\-]+\s*\(at\)\s*[\w.\-]+\s*\(dot\)\s*[\w.\-]+/i,
    );
    if (parenMatch) {
      email = parenMatch[0]
        .replace(/\s*\(at\)\s*/gi, "@")
        .replace(/\s*\(dot\)\s*/gi, ".");
    }
  }

  // Strategy 9: Broad email regex on visible text (last resort)
  if (!email) {
    const visibleText = rawHtml
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ");
    const matches =
      visibleText.match(
        /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
      ) || [];
    for (const m of matches) {
      if (!/\.(png|jpg|jpeg|gif|svg|css|js|woff|ttf|webp|ico)$/i.test(m)) {
        email = m.trim();
        break;
      }
    }
  }

  // Clean up: decode remaining HTML entities
  if (email && /&#\d+;|&\w+;/.test(email)) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = email;
    email = textarea.value.trim();
  }

  // Final validation
  if (
    email &&
    !/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email)
  ) {
    email = "";
  }

  return email.toLowerCase();
}

// ─── Company Extraction (JSON-LD → DOM fallback) ─────────────────────────────────

function extractCompanyFromDoc(doc) {
  // Priority 1: JSON-LD structured data (supports standard and @graph trees)
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent);
      const items = Array.isArray(data)
        ? data
        : data["@graph"] || [data];
      for (const item of items) {
        if (item.hiringOrganization && item.hiringOrganization.name) {
          return item.hiringOrganization.name.trim();
        }
        if (item["@type"] === "Organization" && item.name) {
          return item.name.trim();
        }
      }
    } catch (e) {} // Malformed JSON, skip
  }

  // Priority 2: DOM selectors (broadest set, covers ausbildung.de + azubi.de)
  const selectors = [
    ".jp-c-header__corporation-link",
    '[class*="corporation-link"]',
    '[class*="company-name"]',
    '[class*="companyName"]',
    '[class*="employer-name"]',
    '[class*="employerName"]',
    '[class*="employer"]',
    '[class*="corporation"]',
    '[itemprop="name"]',
    '[class*="hiring-organization"]',
  ];
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (el) {
      const text = el.textContent.trim();
      if (text && text.length < 120) return text;
    }
  }
  return "";
}

// ─── Address Extraction (JSON-LD → DOM fallback) ─────────────────────────────────

function extractAddressFromDoc(doc) {
  // Priority 1: JSON-LD structured data (supports standard and @graph trees)
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent);
      const items = Array.isArray(data)
        ? data
        : data["@graph"] || [data];
      for (const item of items) {
        // JobPosting jobLocation
        if (item.jobLocation) {
          const loc = Array.isArray(item.jobLocation)
            ? item.jobLocation[0]
            : item.jobLocation;
          if (loc && loc.address) {
            const addr = loc.address;
            if (typeof addr === "string" && addr.trim()) return addr.trim();
            const street = addr.streetAddress || "";
            const postal = addr.postalCode || "";
            const city = addr.addressLocality || "";
            if (street) {
              const extra = [postal, city].filter(
                (p) => p && !street.includes(p),
              );
              return extra.length
                ? `${street}, ${extra.join(", ")}`
                : street;
            }
            const parts = [postal, city].filter(Boolean);
            if (parts.length) return parts.join(", ");
          }
          // Sometimes address is directly on the Place
          if (loc && loc.name) return loc.name.trim();
        }
        // Direct address field
        if (item.address) {
          const addr = item.address;
          if (typeof addr === "string" && addr.trim()) return addr.trim();
          const parts = [
            addr.streetAddress,
            addr.postalCode,
            addr.addressLocality,
          ].filter(Boolean);
          if (parts.length) return parts.join(", ");
        }
      }
    } catch (e) {}
  }

  // Priority 2: itemprop selectors (schema.org microdata)
  const locality = doc.querySelector('[itemprop="addressLocality"]');
  const postal = doc.querySelector('[itemprop="postalCode"]');
  const street = doc.querySelector('[itemprop="streetAddress"]');
  if (locality || postal || street) {
    return [street, postal, locality]
      .map((el) => (el ? el.textContent.trim() : ""))
      .filter(Boolean)
      .join(", ");
  }

  // Priority 3: Location-specific selectors
  const selectors = [
    ".jp-title__address",
    '[class*="job-location"]',
    '[class*="jobLocation"]',
    '[class*="location-text"]',
    '[class*="locationText"]',
    '[class*="standort"]',
    '[class*="city"]',
    '[class*="ort"]',
    '[data-testid*="location"]',
    '[data-testid*="address"]',
  ];
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (el) {
      const text = el.textContent.replace(/📍/g, "").trim();
      if (text && text.length < 100) return text;
    }
  }
  return "";
}

// ─── Phone Extraction ────────────────────────────────────────────────────────────

function extractPhoneFromHtml(html) {
  if (!html) return "";
  const telMatch = html.match(/href=["']tel:([^"'?\s]+)/i);
  if (telMatch) return telMatch[1].trim();
  return "";
}

// ─── Website Extraction (JSON-LD → Button/Link → Container) ──────────────────────

/**
 * Extract company website URL from job detail document.
 * Looks in JSON-LD structured data, explicit company website buttons/links, and external links.
 * Excludes job portal domains, social media, app stores, and tracking links.
 *
 * @param {Document} doc - Parsed DOM of the job listing
 * @param {string} [currentHost=""] - Host of current portal to exclude (e.g. "azubi.de", "ausbildung.de")
 * @returns {string} - Clean absolute website URL or ""
 */
function extractWebsiteFromDoc(doc, currentHost = "") {
  if (!doc) return "";

  const IGNORED_DOMAINS = [
    "facebook.com", "instagram.com", "linkedin.com", "xing.com",
    "twitter.com", "x.com", "youtube.com", "tiktok.com", "pinterest.com",
    "google.com", "google.de", "apple.com", "kununu.com",
    "play.google.com", "apps.apple.com", "whatsapp.com", "t.me",
    "arbeitsagentur.de", "ausbildung.de", "aubi-plus.de", "azubi.de",
    "dasoertliche.de", "stepstone.de", "indeed.com", "stellenanzeigen.de",
  ];

  function normalizeCandidateUrl(urlStr) {
    if (!urlStr || typeof urlStr !== "string") return "";
    let trimmed = urlStr.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      trimmed = "https://" + trimmed.replace(/^\/\//, "");
    }
    return trimmed;
  }

  function isValidCompanyUrl(urlStr) {
    try {
      const normalized = normalizeCandidateUrl(urlStr);
      const parsed = new URL(normalized);
      if (!["http:", "https:"].includes(parsed.protocol)) return false;
      const host = parsed.hostname.toLowerCase();
      if (currentHost && (host === currentHost || host.endsWith("." + currentHost))) return false;
      if (IGNORED_DOMAINS.some((d) => host === d || host.endsWith("." + d))) return false;
      return true;
    } catch {
      return false;
    }
  }

  function cleanUrl(urlStr) {
    try {
      const normalized = normalizeCandidateUrl(urlStr);
      const parsed = new URL(normalized);
      ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "fbclid"].forEach(p => parsed.searchParams.delete(p));
      return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname);
    } catch {
      return urlStr;
    }
  }

  // Priority 1: JSON-LD structured data (JobPosting hiringOrganization.sameAs or .url, supports @graph)
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent);
      const items = Array.isArray(data)
        ? data
        : data["@graph"] || [data];
      for (const item of items) {
        const org = item.hiringOrganization || (typeof item["@type"] === "string" && /Organization|Corporation|Company|School|Hospital|EducationalOrganization|LocalBusiness/i.test(item["@type"]) ? item : null);
        if (org) {
          const candidate = org.sameAs || org.url;
          if (candidate && typeof candidate === "string" && isValidCompanyUrl(candidate)) {
            return cleanUrl(candidate);
          }
          if (Array.isArray(candidate)) {
            const valid = candidate.find((u) => typeof u === "string" && isValidCompanyUrl(u));
            if (valid) return cleanUrl(valid);
          }
        }
      }
    } catch (e) {}
  }

  // Priority 2: Links with explicit website text or aria-label
  const anchors = Array.from(doc.querySelectorAll("a[href^='http']"));
  for (const a of anchors) {
    const text = (a.textContent || "").toLowerCase().trim();
    const aria = (a.getAttribute("aria-label") || "").toLowerCase();
    const href = a.getAttribute("href") || "";
    const isWebsiteLabel =
      /^(zur\s+)?(unternehmens[- ]?)?web(seite|site)|homepage|internetauftritt|firmen[- ]?website$/i.test(text) ||
      text.includes("zur website") ||
      text.includes("zur webseite") ||
      text.includes("unternehmens-website") ||
      text.includes("unternehmenswebsite") ||
      text.includes("arbeitgeber-website") ||
      text.includes("website ansehen") ||
      text.includes("webseite ansehen") ||
      text.includes("homepage ansehen") ||
      aria.includes("website") ||
      aria.includes("webseite") ||
      aria.includes("homepage");

    if (isWebsiteLabel && isValidCompanyUrl(href)) {
      return cleanUrl(href);
    }
  }

  // Priority 3: Links with website-like classes or data-qa/test attributes
  const classSelectors = [
    'a[data-qa*="website"]',
    'a[data-test*="website"]',
    'a[data-testid*="website"]',
    'a[class*="company-website"]',
    'a[class*="companyWebsite"]',
    'a[class*="employer-website"]',
    'a[class*="employerWebsite"]',
    'a[class*="corporation-website"]',
  ];
  for (const sel of classSelectors) {
    const el = doc.querySelector(sel);
    if (el) {
      const href = el.getAttribute("href") || "";
      if (isValidCompanyUrl(href)) return cleanUrl(href);
    }
  }

  // Priority 4: External link within company profile or sidebar container
  const containerSelectors = [
    ".company-profile",
    ".company-info",
    ".employer-info",
    ".jp-c-header__corporation",
    '[class*="company-card"]',
    '[class*="employer-card"]',
    '[class*="company-header"]',
    '[class*="company-sidebar"]',
    '[class*="company"]',
  ];
  for (const cSel of containerSelectors) {
    const container = doc.querySelector(cSel);
    if (container) {
      const extLinks = container.querySelectorAll("a[href^='http']");
      for (const a of extLinks) {
        const href = a.getAttribute("href") || "";
        if (isValidCompanyUrl(href)) return cleanUrl(href);
      }
    }
  }

  // Priority 5: Any valid external link (especially useful on company profile subpages)
  for (const a of anchors) {
    const href = a.getAttribute("href") || "";
    if (isValidCompanyUrl(href)) return cleanUrl(href);
  }

  return "";
}

/**
 * Cache mapping portal company profile URLs -> external company website URLs.
 * Avoids re-fetching the company profile page when a company has multiple job listings.
 */
const companyProfileWebsiteCache = new Map();

/**
 * Resolve the external company website for a job offer.
 * 1. Checks if the job offer document itself has the external website.
 * 2. If not, identifies the portal's internal company profile link (e.g. /premium/, /unternehmen/, /betrieb/)
 *    and fetches that profile page to extract the official company website (cached per profile).
 *
 * @param {Document} doc - Job detail page Document
 * @param {string} currentHost - Portal hostname ('aubi-plus.de', 'azubi.de', 'ausbildung.de')
 * @returns {Promise<string>} - Extracted company website or ""
 */
async function resolveCompanyWebsite(doc, currentHost = "") {
  if (!doc) return "";

  // Strategy 1: Direct extraction from the job offer page
  let website = extractWebsiteFromDoc(doc, currentHost);
  if (website) return website;

  // Strategy 2: Portal Company Profile Bridge
  // Job portals like Aubi-Plus, Azubi.de, and Ausbildung.de link to internal company profiles
  try {
    let profileHref = "";

    if (currentHost.includes("aubi-plus.de")) {
      const pLinks = Array.from(doc.querySelectorAll('a[href*="/premium/"], a[href*="/betrieb/"], a[href*="/unternehmen/"], a[href*="/institution/"]'));
      for (const a of pLinks) {
        const h = a.getAttribute("href") || "";
        if (!h.includes("/alle") && h !== "/unternehmen/" && h !== "/premium/") {
          profileHref = h;
          break;
        }
      }
    } else if (currentHost.includes("azubi.de")) {
      // Check JSON-LD hiringOrganization.url
      const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        try {
          const d = JSON.parse(s.textContent);
          const items = Array.isArray(d) ? d : d["@graph"] || [d];
          for (const item of items) {
            const orgUrl = item.hiringOrganization && (item.hiringOrganization.url || item.hiringOrganization.sameAs);
            if (orgUrl && orgUrl.includes("/unternehmen/") && !orgUrl.includes("/alle")) {
              profileHref = orgUrl;
              break;
            }
          }
        } catch (e) {}
        if (profileHref) break;
      }
      if (!profileHref) {
        const pLinks = Array.from(doc.querySelectorAll('a[href*="/unternehmen/"]'));
        for (const a of pLinks) {
          const h = a.getAttribute("href") || "";
          if (!h.includes("/alle") && h !== "/unternehmen/") {
            profileHref = h;
            break;
          }
        }
      }
    } else if (currentHost.includes("ausbildung.de")) {
      // Check JSON-LD for company profile URL (Corporation / Organization url)
      const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        try {
          const d = JSON.parse(s.textContent);
          const items = Array.isArray(d) ? d : d["@graph"] || [d];
          for (const item of items) {
            if (item.url && typeof item.url === "string" && item.url.includes("/unternehmen/") && !item.url.includes("/alle")) {
              profileHref = item.url;
              break;
            }
          }
        } catch (e) {}
        if (profileHref) break;
      }

      if (!profileHref) {
        const pLinks = Array.from(doc.querySelectorAll('a[href*="/unternehmen/"], a[href*="/arbeitgeber/"]'));
        for (const a of pLinks) {
          const h = a.getAttribute("href") || "";
          if (
            !h.includes("/unternehmen/alle") &&
            !h.includes("/duales-studium/unternehmen") &&
            h !== "/unternehmen/" &&
            h !== "/unternehmen"
          ) {
            profileHref = h;
            break;
          }
        }
      }

      // Normalize profile URL to base company profile (remove /stellen/, /bewertungen/, etc.)
      if (profileHref) {
        profileHref = profileHref.split("?")[0].replace(/\/(stellen|bewertungen|lebenslauf|kontakt)\/.*$/, "/");
      }
    }

    if (!profileHref) return "";

    // Build absolute URL for the company profile
    let profileUrl = profileHref;
    if (!profileUrl.startsWith("http")) {
      const cleanHost = currentHost.replace(/^www\./, "");
      profileUrl = `https://www.${cleanHost}${profileHref.startsWith("/") ? "" : "/"}${profileHref}`;
    }

    // Check cache: if this company's profile was already inspected in this session
    if (companyProfileWebsiteCache.has(profileUrl)) {
      return companyProfileWebsiteCache.get(profileUrl);
    }

    console.log(`[DeepLookup] Checking portal company profile for website: ${profileUrl}`);
    const resp = await chrome.runtime.sendMessage({
      action: "fetch_text",
      url: profileUrl,
    });

    if (resp && resp.success && resp.text) {
      const profileDoc = parseHtml(resp.text);
      website = extractWebsiteFromDoc(profileDoc, currentHost);
      companyProfileWebsiteCache.set(profileUrl, website);
      if (website) {
        console.log(`[DeepLookup] ✓ Discovered company website from profile: ${website}`);
      }
      return website;
    }
  } catch (e) {
    console.warn("[DeepLookup] Error resolving company profile website:", e);
  }

  return "";
}

// ─── Website Impressum / Contact Page Email Crawler ─────────────────────────────

/**
 * Shared domain crawl cache: avoids re-fetching the same company website in one session.
 */
const crawledDomains = new Map(); // domain -> email or ''

/**
 * Crawl a company's website to find email from homepage / Impressum / Kontakt pages.
 * German law (§ 5 TMG / DDG) requires every commercial website to publish contact details.
 *
 * @param {string} websiteUrl - Company website URL
 * @returns {Promise<string>} - Extracted email or ""
 */
async function crawlWebsiteForEmail(websiteUrl) {
  if (!websiteUrl) return "";

  try {
    let rawUrl = websiteUrl.trim();
    if (!/^https?:\/\//i.test(rawUrl)) {
      rawUrl = "https://" + rawUrl.replace(/^\/\//, "");
    }
    const parsedBase = new URL(rawUrl);
    const origin = parsedBase.origin;
    const baseUrl = rawUrl.replace(/\/+$/, "");

    // Step 1: Check the landing page / homepage first (email often in footer)
    const homeUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
    const homeResp = await chrome.runtime.sendMessage({
      action: "fetch_text_utf8",
      url: homeUrl,
    });

    if (homeResp && homeResp.success && homeResp.text) {
      const homeEmail = extractEmailFromHtml(homeResp.text);
      if (homeEmail) {
        console.log(`[DeepLookup] Found email on page: ${homeEmail}`);
        return homeEmail;
      }
    }

    // If the provided URL was a deep subpage, also check the root homepage
    if (origin + "/" !== homeUrl) {
      const originResp = await chrome.runtime.sendMessage({
        action: "fetch_text_utf8",
        url: origin + "/",
      });
      if (originResp && originResp.success && originResp.text) {
        const originEmail = extractEmailFromHtml(originResp.text);
        if (originEmail) {
          console.log(`[DeepLookup] Found email on root homepage: ${originEmail}`);
          return originEmail;
        }
      }
    }

    // Step 2: Build prioritized contact URLs
    // Impressum has highest priority under German DDG/TMG § 5 (legal requirement for contact email)
    const contactCandidates = [];

    // Dynamically scan for exact Impressum/Kontakt links from the page HTML
    const pageHtml = (homeResp && homeResp.success && homeResp.text) ? homeResp.text : "";
    if (pageHtml) {
      try {
        const doc = parseHtml(pageHtml);
        const links = Array.from(doc.querySelectorAll("a"));

        const dynamicLinks = [];
        for (const a of links) {
          const text = (a.textContent || "").toLowerCase().trim();
          const href = (a.getAttribute("href") || "").trim();
          if (!href || /^(javascript:|mailto:|tel:|#)/i.test(href)) continue;

          const isImpressum = text.includes("impressum") || href.toLowerCase().includes("impressum") || href.toLowerCase().includes("imprint");
          const isKontakt = text.includes("kontakt") || href.toLowerCase().includes("kontakt") || href.toLowerCase().includes("contact");

          if (isImpressum) {
            dynamicLinks.unshift(href); // Impressum gets highest priority
          } else if (isKontakt) {
            dynamicLinks.push(href);
          }
        }

        for (const dHref of dynamicLinks) {
          try {
            const resolved = new URL(dHref, homeUrl).href;
            if (["http:", "https:"].includes(new URL(resolved).protocol)) {
              contactCandidates.push(resolved);
            }
          } catch (e) {}
        }
      } catch (e) {}
    }

    // Standard German compliance fallback paths
    const standardPaths = ["/impressum", "/kontakt", "/imprint", "/de/impressum"];
    for (const p of standardPaths) {
      contactCandidates.push(new URL(p, origin).href);
      if (baseUrl !== origin) {
        try {
          contactCandidates.push(new URL(p, baseUrl + "/").href);
        } catch (e) {}
      }
    }

    // Deduplicate contact URLs, excluding what we already checked
    const uniqueContactUrls = [...new Set(contactCandidates)].filter((u) => u !== homeUrl && u !== origin + "/");

    // Step 3: Try contact pages in order of priority (up to first 3 to prevent timeout)
    for (const contactUrl of uniqueContactUrls.slice(0, 3)) {
      console.log(`[DeepLookup] Trying contact page: ${contactUrl}`);
      const resp = await chrome.runtime.sendMessage({
        action: "fetch_text_utf8",
        url: contactUrl,
      });
      if (resp && resp.success && resp.text) {
        const email = extractEmailFromHtml(resp.text);
        if (email) {
          console.log(`[DeepLookup] Found email on ${contactUrl}: ${email}`);
          return email;
        }
      }
    }
  } catch (e) {
    console.error("[DeepLookup] Error crawling website for email:", e);
  }

  return "";
}

/**
 * Timeout-guarded wrapper around crawlWebsiteForEmail.
 * Caches results per domain to prevent duplicate network requests.
 *
 * @param {string} websiteUrl - Company website URL
 * @param {number} timeoutMs - Timeout in ms (default: 5000)
 * @returns {Promise<string>} - Extracted email or ""
 */
async function crawlWebsiteForEmailWithTimeout(websiteUrl, timeoutMs = 5000) {
  try {
    const domain = new URL(websiteUrl).hostname;
    if (crawledDomains.has(domain)) {
      return crawledDomains.get(domain);
    }
    const email = await Promise.race([
      crawlWebsiteForEmail(websiteUrl),
      new Promise((resolve) => setTimeout(() => resolve(""), timeoutMs)),
    ]);
    crawledDomains.set(domain, email);
    return email;
  } catch (e) {
    return "";
  }
}


// ─── Smart Element Waiter (MutationObserver) ─────────────────────────────────────

/**
 * Wait for an element to appear in the DOM using MutationObserver.
 * More efficient than polling — returns as soon as the element appears.
 * Supports both CSS selector strings and callback functions.
 *
 * @param {string|Function} selector - CSS selector or function returning an element
 * @param {number} timeoutMs - Max time to wait before returning null (default: 5000ms)
 * @returns {Promise<Element|null>}
 */
function waitForElement(selector, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const check =
      typeof selector === "function"
        ? selector
        : () => document.querySelector(selector);

    const existing = check();
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const el = check();
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

// ─── Fetch with Retry ────────────────────────────────────────────────────────────

/**
 * Wrapper around fetch() with automatic retry and linear backoff.
 * On non-ok responses or network errors, retries up to `retries` times
 * with increasing delay between attempts.
 *
 * @param {string} url - URL to fetch
 * @param {RequestInit} options - Standard fetch options
 * @param {number} retries - Number of retry attempts (default: 2)
 * @param {number} baseDelayMs - Base delay in ms, multiplied by attempt number (default: 1000)
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}, retries = 2, baseDelayMs = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok || attempt >= retries) return response;
      // Respect rate limiting — back off significantly on 429
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After')) || 0;
        const wait = Math.max(retryAfter * 1000, baseDelayMs * Math.pow(2, attempt + 2));
        console.warn(
          `[fetchWithRetry] 429 rate limited, waiting ${wait}ms before retry`,
        );
        await sleep(wait);
        continue;
      }
      console.warn(
        `[fetchWithRetry] Attempt ${attempt + 1}/${retries + 1} failed (HTTP ${response.status}): ${url}`,
      );
    } catch (err) {
      if (attempt >= retries) throw err;
      console.warn(
        `[fetchWithRetry] Attempt ${attempt + 1}/${retries + 1} error: ${err.message}`,
      );
    }
    await sleep(baseDelayMs * (attempt + 1));
  }
}

// ─── URL Resolution Helper ──────────────────────────────────────────────────────

/**
 * Resolve a possibly-relative href from DOMParser output.
 * DOMParser resolves relative URLs against the chrome-extension:// origin,
 * which is incorrect. This helper normalizes them to the correct base.
 *
 * @param {string} rawHref - The raw href value (may be relative, absolute, or chrome-extension://)
 * @param {string} baseOrigin - The correct base origin (e.g. 'https://www.aubi-plus.de')
 * @returns {string} Fully resolved URL
 */
function resolveHref(rawHref, baseOrigin) {
  if (!rawHref) return '';
  if (rawHref.startsWith('chrome-extension://')) {
    // DOMParser resolved a relative path against the extension origin — fix it
    const path = rawHref.replace(/^chrome-extension:\/\/[^/]+/, '');
    return baseOrigin.replace(/\/+$/, '') + path;
  }
  if (rawHref.startsWith('/')) {
    return baseOrigin.replace(/\/+$/, '') + rawHref;
  }
  return rawHref;
}

// ─── Shared Message Handler Factory ──────────────────────────────────────────────

/**
 * Creates a chrome.runtime.onMessage listener with common scraper actions built in.
 * Scripts provide custom handlers via `callbacks` and the factory handles boilerplate
 * for pause, resume, stop, getInitialInfo, and getData.
 *
 * All handlers automatically return true (async-safe).
 *
 * @param {Function} getState - Returns { isScraping, isPaused } from the script's scope
 * @param {Object} callbacks - Action handlers and lifecycle hooks:
 *   Custom action handlers (override defaults):
 *     - start(request, sendResponse)
 *     - reset(request, sendResponse)
 *     - countResults(request, sendResponse)
 *     - getData(request, sendResponse)
 *     - getInitialInfo(request, sendResponse)
 *   Lifecycle hooks (called by default handlers):
 *     - onSettings(settings) — called when settings message arrives
 *     - onPause()            — called on 'pause' action
 *     - onResume()           — called on 'resume' action
 *     - onStop()             — called on 'stop' action
 * @returns {Function} Listener for chrome.runtime.onMessage.addListener
 */
function createScraperMessageHandler(getState, callbacks) {
  return (request, sender, sendResponse) => {
    // Settings propagation
    if (request.settings) {
      if (callbacks.onSettings) callbacks.onSettings(request.settings);
      if (!request.action) {
        sendResponse({ status: "settings_applied" });
        return true;
      }
    }

    const action = request.action;
    if (!action) return;

    // Custom handlers take full priority
    if (callbacks[action]) {
      callbacks[action](request, sendResponse);
      return true;
    }

    // Default handlers for common actions
    switch (action) {
      case "pause":
        if (callbacks.onPause) callbacks.onPause();
        sendResponse({ status: "paused" });
        return true;

      case "resume":
        if (callbacks.onResume) callbacks.onResume();
        sendResponse({ status: "resumed" });
        return true;

      case "stop":
        if (callbacks.onStop) callbacks.onStop();
        sendResponse({ status: "stopped" });
        return true;

      case "updateLimit":
        if (callbacks.onUpdateLimit) callbacks.onUpdateLimit(request.limit);
        sendResponse({ status: "updated" });
        return true;

      case "getInitialInfo":
        chrome.storage.local.get(["scrapedData"], (res) => {
          const state = getState();
          sendResponse({
            isScraping: state.isScraping,
            isPaused: state.isPaused,
            scrapedCount: res.scrapedData ? res.scrapedData.length : 0,
          });
        });
        return true;

      case "getData":
        chrome.storage.local.get(["scrapedData"], (res) => {
          sendResponse({ data: res.scrapedData || [] });
        });
        return true;

      default:
        return false; // Unhandled action — let other listeners handle it
    }
  };
}

/**
 * Automatically export scraped leads to Excel if autoExport setting is enabled.
 * @param {Array<Object>} data - Array of scraped lead objects
 * @param {Object} settings - Settings object containing autoExport boolean
 * @returns {boolean} True if export was triggered successfully
 */
function triggerAutoExport(data, settings) {
  if (!settings || !settings.autoExport || !data || data.length === 0) {
    return false;
  }
  try {
    if (typeof window.downloadExcel === "function") {
      window.downloadExcel(data);
      return true;
    }
  } catch (err) {
    console.error("[AutoAzubi] Auto-export error:", err);
  }
  return false;
}

// ─── Module Export for Node Unit Tests ──────────────────────────────────────────
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseHtml,
    decodeHtmlEntities,
    safeSendMessage,
    playAudioSafely,
    StorageHelper,
    isDuplicateEmail,
    extractEmailFromHtml,
    extractPhoneFromHtml,
    extractCompanyFromDoc,
    extractAddressFromDoc,
    resolveCompanyWebsite,
    resolveHref,
    triggerAutoExport,
    createScraperMessageHandler,
  };
}
