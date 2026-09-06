/**
 * Job Scraper Content Script V2.2
 * Added: Persistence, improved pause/resume, and optimized filtering.
 */

let isScraping = false;
let isPaused = false;
let scrapedData = [];
let targetLimit = 0;
let filtersApplied = false;
let currentCardIndex = 0;

const PORTAL_SOURCE = 'Arbeitsagentur';

// Audio setup
const captchaSound = new Audio(chrome.runtime.getURL('captcha.mp3'));
const finishedSound = new Audio(chrome.runtime.getURL('finished.mp3'));

// Settings Cache
let settings = {
    notifyCaptcha: false,
    notifyFinish: true,
    autoExport: false
};

// Initialize State from Storage
StorageHelper.get(['scrapedData', 'isScraping', 'isPaused', 'targetLimit', 'filtersApplied', 'currentCardIndex', 'waitingForCaptcha', 'notifyCaptcha', 'notifyFinish', 'autoExport']).then((result) => {
    if (result.scrapedData) scrapedData = result.scrapedData;
    if (result.isScraping !== undefined) isScraping = result.isScraping;
    if (result.isPaused !== undefined) isPaused = result.isPaused;
    if (result.targetLimit) targetLimit = result.targetLimit;
    if (result.filtersApplied !== undefined) filtersApplied = result.filtersApplied;
    if (result.currentCardIndex !== undefined) currentCardIndex = result.currentCardIndex;

    settings.notifyCaptcha = result.notifyCaptcha === true;
    settings.notifyFinish = result.notifyFinish !== false;
    settings.autoExport = result.autoExport === true;

    console.log(`State recovered: ${scrapedData.length} records, isScraping: ${isScraping}, isPaused: ${isPaused}`);

    if (isScraping && !isPaused) {
        // If page reloaded while waiting for captcha, auto-PAUSE instead of
        // auto-restarting. This prevents the loop where the script keeps
        // restarting, hitting captcha, page refreshes, repeat.
        if (result.waitingForCaptcha) {
            console.log('[Recovery] Was waiting for captcha — auto-pausing to avoid loop.');
            isPaused = true;
            StorageHelper.setMultiple({ waitingForCaptcha: false, isPaused: true });
            safeSendMessage({
                action: 'progress',
                status: 'paused',
                count: scrapedData.length,
                portalCount: scrapedData.filter(d => d.source === PORTAL_SOURCE).length,
                currentTitle: '⚠ Captcha — tap Resume after solving'
            });
        } else {
            startScraping();
        }
    }
});

// Update Storage helper
function updateStorage() {
    StorageHelper.setMultiple({
        scrapedData,
        isScraping,
        isPaused,
        targetLimit,
        filtersApplied,
        currentCardIndex
    });
}

// waitForElement() provided by utils.js (MutationObserver-based, loaded first via manifest.json)

// Listen for messages from popup
// Uses shared createScraperMessageHandler from utils.js for consistency.
chrome.runtime.onMessage.addListener(
    createScraperMessageHandler(
        () => ({ isScraping, isPaused }),
        {
            onSettings: (s) => {
                settings = s;
                StorageHelper.setMultiple(s);
            },
            onUpdateLimit: (limit) => { targetLimit = limit; },
            onPause: () => {
                isPaused = true;
                updateStorage();
            },
            onResume: () => {
                isPaused = false;
                updateStorage();
                if (isScraping) startScraping();
            },
            onStop: () => {
                isScraping = false;
                isPaused = false;
                StorageHelper.set('waitingForCaptcha', false);
                updateStorage();
            },
            start: (request, sendResponse) => {
                isScraping = true;
                isPaused = false;
                if (request.reset) {
                    scrapedData = [];
                    filtersApplied = false;
                    currentCardIndex = 0;
                }
                targetLimit = request.limit || 50;
                StorageHelper.set('waitingForCaptcha', false);
                updateStorage();
                startScraping();
                sendResponse({ status: 'started' });
            },
            reset: (request, sendResponse) => {
                isScraping = false;
                isPaused = false;
                scrapedData = [];
                filtersApplied = false;
                currentCardIndex = 0;
                StorageHelper.set('waitingForCaptcha', false);
                updateStorage();
                sendResponse({ status: 'reset' });
            },
            getData: (request, sendResponse) => {
                sendResponse({ data: scrapedData });
            },
            getInitialInfo: (request, sendResponse) => {
                getInitialInfo().then(total => sendResponse({
                    total,
                    scrapedCount: scrapedData.filter(d => d.source === PORTAL_SOURCE).length,
                    isScraping,
                    isPaused
                }));
            },
            countResults: (request, sendResponse) => {
                countResults().then(total => {
                    filtersApplied = true;
                    updateStorage();
                    sendResponse({ total });
                });
            },
        }
    )
);

async function getInitialInfo() {
    const total = document.getElementById('suchergebnis-h1-anzeige');
    const totalText = total ? total.innerText.replace(/[^0-9]/g, '') : '0';
    return parseInt(totalText) || 0;
}

async function countResults() {
    console.log("Applying filters before counting...");
    await applyFilter();
    await sleep(800);
    return await getInitialInfo();
}

async function startScraping() {
    try {
        await _startScraping();
    } catch (err) {
        console.error('Scraping error:', err);
        isScraping = false;
        isPaused = false;
        updateStorage();
        safeSendMessage({ action: 'error', message: String(err) });
    }
}

async function _startScraping() {
    // 1. Initial Filtering (only if not already applied)
    if (!filtersApplied) {
        await applyFilter();
        filtersApplied = true;
        updateStorage();
    }

    // 2. Select List View (if tab exists — removed in newer site versions)
    const viewTab = document.getElementById('ansicht-auswahl-tabbar-item-1');
    if (viewTab) {
        console.log("Switching to list view...");
        viewTab.click();
        await sleep(800);
    }

    let portalCount = scrapedData.filter(d => d.source === PORTAL_SOURCE).length;

    while (isScraping) {
        if (isPaused) {
            console.log("Scraping paused...");
            break; // Exit loop, resume will re-call startScraping
        }

        let cards = document.querySelectorAll('[id^="ergebnisliste-item-"]');

        if (portalCount < targetLimit) {
            for (let i = currentCardIndex; i < cards.length; i++) {
                if (!isScraping || isPaused) break;
                if (portalCount >= targetLimit) break;

                const card = cards[i];
                card.click();

                // Smart wait: return as soon as the detail panel or bewerbung button appears
                await waitForElement(
                    () => document.getElementById('detailansicht-zur-bewerbung') || document.getElementById('detail-bewerbung-mail'),
                    2000
                );

                // Click "Info zur Bewerbung" to request contact details
                const bewerbungBtn = document.getElementById('detailansicht-zur-bewerbung');
                if (bewerbungBtn) {
                    bewerbungBtn.click();
                    // Wait for either captcha OR contact details to appear
                    await waitForElement(
                        () => document.getElementById('captchaForm')
                            || document.querySelector('form[id*="captcha"]')
                            || document.getElementById('kontaktdaten-captcha-input')
                            || document.querySelector('[id*="kontaktdaten-captcha"]')
                            || document.getElementById('detail-bewerbung-mail')
                            || document.getElementById('detail-bewerbung-adresse'),
                        4000
                    );
                }

                // Handle captcha (appears after requesting contact info)
                if (await handleCaptcha()) {
                    // captcha was solved, brief wait for contact details to load
                    await sleep(500);
                }

                // Smart wait: poll for contact details to appear (up to 4 seconds)
                await waitForElement(
                    () => document.getElementById('detail-bewerbung-mail') || document.getElementById('detail-bewerbung-adresse'),
                    4000
                );

                const info = extractInfo();
                if (info) {
                    // Email dedup: skip if this email was already scraped
                    if (isDuplicateEmail(scrapedData, info.email)) {
                        console.log(`Card ${i}: Duplicate email ${info.email}, skipping.`);
                    } else {
                        // Try to find website link in the detail panel
                        const linkElement = document.querySelector('#agdarstellung-websitelink') ||
                            document.querySelector('[id*="websitelink"]') ||
                            document.querySelector('.detail-bewerbung a[href^="http"]');
                        info.link = linkElement ? linkElement.href : '';

                        scrapedData.push(info);
                        portalCount++;
                        console.log(`Extracted (${portalCount}/${targetLimit}):`, info);
                        safeSendMessage({ action: 'progress', count: scrapedData.length, portalCount, currentTitle: info.company });
                    }
                } else {
                    console.log(`Card ${i}: No email found, skipping.`);
                }

                await sleepWithThrottle(150);
                currentCardIndex = i + 1;
                // Save after every card for better captcha recovery
                updateStorage();
            }
        }

        portalCount = scrapedData.filter(d => d.source === PORTAL_SOURCE).length;
        if (portalCount >= targetLimit) {
            console.log("Target limit reached.");
            break;
        }

        const loadMoreBtn = document.getElementById('ergebnisliste-ladeweitere-button');
        if (loadMoreBtn && isScraping && !isPaused) {
            const prevCount = cards.length;

            // If currentCardIndex is beyond visible cards (e.g. after page reload),
            // we already processed these cards in a previous session.
            // Just click Load More without resetting index.
            if (currentCardIndex <= prevCount) {
                currentCardIndex = prevCount; // Continue from where new cards will appear
            }
            // Otherwise keep currentCardIndex as-is (it was saved from a previous session
            // and might point into the next batch)

            console.log(`Loading more results... (currentCardIndex: ${currentCardIndex})`);
            loadMoreBtn.click();
            // Wait for new cards to actually appear instead of fixed sleep
            await waitForElement(
                () => {
                    const newCards = document.querySelectorAll('[id^="ergebnisliste-item-"]');
                    return newCards.length > prevCount ? newCards[prevCount] : null;
                },
                5000
            );
            await sleep(300); // Brief settle time after DOM update
        } else if (!loadMoreBtn) {
            console.log("No more results available.");
            break;
        }
    }

    // Only set finished if we actually hit the limit or ran out of results
    if (isScraping && !isPaused && (portalCount >= targetLimit || !document.getElementById('ergebnisliste-ladeweitere-button'))) {
        if (settings.notifyFinish) playAudioSafely(finishedSound);
        isScraping = false;
        isPaused = false;
        updateStorage();
        const autoExported = triggerAutoExport(scrapedData, settings);
        safeSendMessage({ action: 'finished', count: scrapedData.length, portalCount, totalChecked: currentCardIndex, autoExported });
    }
}

async function applyFilter() {
    console.log("Checking filter state...");
    const filterToggle = document.getElementById('filter-toggle');
    if (filterToggle) {
        if (filterToggle.getAttribute('aria-expanded') !== 'true') {
            filterToggle.click();
            await sleep(400);
        }

        const extFilter = document.querySelector('input[type="checkbox"][id*="externe"]');
        if (extFilter && !extFilter.checked) {
            console.log("Enabling 'no external offers' filter...");
            extFilter.click();
            await sleep(500);
        }

        const applyBtn = document.getElementById('footer-button-modales-slide-in-filter');
        if (applyBtn) {
            console.log("Clicking apply filters button...");
            applyBtn.click();
            await sleep(800);
        }
    }
}

async function handleCaptcha() {
    let captchaForm = document.getElementById('captchaForm') || document.querySelector('form[id*="captcha"]') || document.getElementById('kontaktdaten-captcha-input') || document.querySelector('[id*="kontaktdaten-captcha"]');
    if (captchaForm) {
        console.log("Captcha detected!");

        // Scroll to captcha so user can solve it immediately
        captchaForm.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Save state immediately so if page refreshes during captcha,
        // recovery knows to auto-pause instead of restarting the loop
        updateStorage();
        StorageHelper.set('waitingForCaptcha', true);

        safeSendMessage({ action: 'progress', status: 'waiting_captcha' });

        // Setup repeating sound every 4 seconds
        let soundInterval = null;
        if (settings.notifyCaptcha) {
            playAudioSafely(captchaSound);
            soundInterval = setInterval(() => {
                const stillExists = document.getElementById('captchaForm') || document.querySelector('form[id*="captcha"]') || document.getElementById('kontaktdaten-captcha-input') || document.querySelector('[id*="kontaktdaten-captcha"]');
                if (stillExists && isScraping) {
                    playAudioSafely(captchaSound);
                } else {
                    clearInterval(soundInterval);
                }
            }, 4000);
        }

        const notice = document.createElement('div');
        notice.id = 'scraper-notice';
        notice.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #161a23;
            color: #f8fafc;
            padding: 0;
            border-radius: 14px;
            z-index: 10000;
            box-shadow: 0 20px 40px rgba(0,0,0,0.5);
            font-family: 'Inter', 'Segoe UI', sans-serif;
            max-width: 340px;
            width: 340px;
            border: 1px solid #2d333f;
            border-top: 3px solid #f59e0b;
            overflow: hidden;
            animation: scraperNoticeIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        `;

        // Add keyframes for entrance animation
        if (!document.getElementById('scraper-notice-styles')) {
            const styleSheet = document.createElement('style');
            styleSheet.id = 'scraper-notice-styles';
            styleSheet.textContent = `
                @keyframes scraperNoticeIn {
                    from { opacity: 0; transform: translateY(-16px) scale(0.96); }
                    to { opacity: 1; transform: translateY(0) scale(1); }
                }
                @keyframes scraperPulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }
                #scraper-notice .notice-icon {
                    width: 44px;
                    height: 44px;
                    border-radius: 50%;
                    background: rgba(245, 158, 11, 0.12);
                    border: 1px solid rgba(245, 158, 11, 0.25);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                    color: #f59e0b;
                    animation: scraperPulse 2s ease-in-out infinite;
                }
                #scraper-notice .notice-header {
                    display: flex;
                    align-items: center;
                    gap: 14px;
                    padding: 20px 20px 0;
                }
                #scraper-notice .notice-header h3 {
                    margin: 0;
                    font-family: 'Outfit', 'Segoe UI', sans-serif;
                    font-size: 16px;
                    font-weight: 700;
                    color: #f8fafc;
                    letter-spacing: -0.3px;
                }
                #scraper-notice .notice-body {
                    padding: 10px 20px 20px;
                    margin-left: 58px;
                }
                #scraper-notice .notice-body p {
                    margin: 0;
                    font-size: 13px;
                    color: #94a3b8;
                    line-height: 1.5;
                }
                #scraper-notice .notice-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    margin-top: 12px;
                    padding: 5px 10px;
                    background: rgba(245, 158, 11, 0.08);
                    border: 1px solid rgba(245, 158, 11, 0.15);
                    border-radius: 6px;
                    font-size: 11px;
                    font-weight: 600;
                    color: #f59e0b;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                #scraper-notice .notice-badge .dot {
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: #f59e0b;
                    animation: scraperPulse 1.5s ease-in-out infinite;
                }
            `;
            document.head.appendChild(styleSheet);
        }

        notice.innerHTML = `
            <div class="notice-header">
                <div class="notice-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                    </svg>
                </div>
                <h3>Captcha Detected</h3>
            </div>
            <div class="notice-body">
                <p>A captcha has appeared. Please solve it manually to continue scraping.</p>
                <div class="notice-badge">
                    <span class="dot"></span>
                    Waiting for solve
                </div>
            </div>
        `;
        document.body.appendChild(notice);

        while (isScraping && (document.getElementById('captchaForm') || document.querySelector('form[id*="captcha"]') || document.getElementById('kontaktdaten-captcha-input') || document.querySelector('[id*="kontaktdaten-captcha"]'))) {
            await sleep(1000);
        }

        // Captcha solved — clear the flag
        StorageHelper.set('waitingForCaptcha', false);

        if (soundInterval) clearInterval(soundInterval);
        if (notice) notice.remove();
        return true;
    }
    return false;
}

function extractInfo() {
    const addressParent = document.getElementById('detail-bewerbung-adresse');
    const mailElement = document.getElementById('detail-bewerbung-mail');
    const phoneElement = document.getElementById('detail-bewerbung-telefon-Telefon');
    const descContainer = document.getElementById('detail-beschreibung-text-container');

    // Skip data without any email source
    if (!mailElement && !descContainer) {
        console.log("No email source found, skipping...");
        return null;
    }

    let company = '';
    let contact = '';
    let address = '';
    let phone = '';

    // ── Email extraction: mailto href → innerText → description fallback ──
    let email = '';
    if (mailElement) {
        // Priority 1: mailto: href (most reliable)
        const href = mailElement.getAttribute('href') || '';
        const mailtoMatch = href.match(/^mailto:([^?\s]+)/i);
        if (mailtoMatch) {
            email = mailtoMatch[1].trim();
        }
        // Priority 2: innerText
        if (!email) {
            email = mailElement.innerText.trim();
        }
    }
    // Priority 3: search in description HTML
    if (!email && descContainer) {
        email = extractEmailFromHtml(descContainer.innerHTML);
    }

    // Validate email format
    if (email && !/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email)) {
        email = '';
    }

    if (!email) return null;

    // ── Phone extraction ──
    if (phoneElement) {
        const href = phoneElement.getAttribute('href') || '';
        phone = href.startsWith('tel:') ? href.replace('tel:', '').trim() : phoneElement.innerText.trim();
    }

    // ── Company / Contact / Address extraction ──
    if (addressParent) {
        const html = addressParent.innerHTML;
        const lines = html.split(/<br\s*\/?>/i).map(l => l.trim().replace(/<.*?>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim()).filter(Boolean);

        company = lines[0] || '';

        // Tighter street heuristic: digit must be part of a number-word pattern
        // like "Musterstr. 12" or "12 Hauptplatz", not just any line with a digit
        const isStreetLine = (line) => {
            if (!line) return false;
            const hasStreetWord = /(?:str|stra|straße|weg|platz|allee|ring|damm|gasse|hof|markt|chaussee|ufer)/i.test(line);
            const hasHouseNumber = /(?:^\d|\s\d|\d\s*$)/.test(line);
            return hasStreetWord && hasHouseNumber;
        };

        if (lines.length > 1 && isStreetLine(lines[1])) {
            contact = '';
            address = lines.slice(1).join(', ');
        } else if (lines.length > 1) {
            contact = lines[1] || '';
            address = lines.slice(2).join(', ');
        }
    }

    // ── Company fallback: detail panel header or page title ──
    if (!company) {
        // Try the detail panel header (Arbeitsagentur shows company name there)
        const detailHeader = document.querySelector('#detail-kopfbereich-titel') ||
            document.querySelector('[id*="detail-kopfbereich"] h2') ||
            document.querySelector('[id*="detail"] [class*="titel"]') ||
            document.querySelector('[class*="detail"] h2') ||
            document.querySelector('.ergebnis-details h2');
        if (detailHeader) {
            const text = detailHeader.textContent.trim();
            if (text && text.length < 120) company = text;
        }
    }

    if (!company) {
        // Try the page's active card title
        const activeCard = document.querySelector('[id^="ergebnisliste-item-"].active, [id^="ergebnisliste-item-"][aria-selected="true"]');
        if (activeCard) {
            const titleEl = activeCard.querySelector('h2, h3, [class*="titel"]');
            if (titleEl) {
                const text = titleEl.textContent.trim();
                if (text && text.length < 120) company = text;
            }
        }
    }

    // ── Try additional phone sources ──
    if (!phone) {
        // Try Fax or Mobil fields if Telefon was not found
        const altPhoneEl = document.getElementById('detail-bewerbung-telefon-Fax') ||
            document.getElementById('detail-bewerbung-telefon-Mobil') ||
            document.querySelector('[id*="detail-bewerbung-telefon"]');
        if (altPhoneEl) {
            const href = altPhoneEl.getAttribute('href') || '';
            phone = href.startsWith('tel:') ? href.replace('tel:', '').trim() : altPhoneEl.innerText.trim();
        }
    }

    return {
        company: company || 'Unknown',
        contact,
        address,
        email,
        phone,
        source: 'Arbeitsagentur',
        extractedAt: new Date().toISOString()
    };
}

// sleep() provided by utils.js
