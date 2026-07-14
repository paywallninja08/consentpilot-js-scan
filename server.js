/**
 * ConsentPilot JS Scanner V2 — SINGLE-FILE server.js for Railway
 * Generated 2026-07-06 from Lovable repo js-scanner-v2 (commit e542fa44)
 *
 * Contains ALL accuracy fixes:
 *  - FIX 2:  gtag.js/gtm.js library loads never counted as GA4 hits;
 *            gcs/gcd parsing; cookieless (G100) pings excluded from
 *            pre-consent violation counts; preConsentFlowFailed + null
 *            counts (no baseline fallback)
 *  - FIX 5:  iframe CMP support (same-origin click-through, cross-origin
 *            explicitly reported as non-interactable)
 *  - FIX 6a: post-click hit counting (postClickGa4/AdsCount) via request
 *            timestamps; AdSense adsbygoogle.js treated as library, not hit
 *
 * Endpoints: GET /health, POST /api/js-scan  (aliases: POST /scan, POST /)
 * Required deps in package.json: express, puppeteer, puppeteer-extra,
 * puppeteer-extra-plugin-stealth
 */

// ============================================================================
// Scanner core (formerly src/scanner/jsScannerV2.js)
// ============================================================================

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// ============================================================================
// Network classification — CENTRALIZED matchers (Scanner V2 accuracy overhaul)
// ============================================================================

/**
 * GA4 measurement HIT matcher (real tracking events only). Library loads
 * like googletagmanager.com/gtag/js are handled by isGa4Library and MUST
 * NOT count here — loading the library pre-consent is compliant behaviour
 * under Consent Mode v2.
 */
function isGa4Hit(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return (
    /google-analytics\.com\/[gj]\/collect/.test(u) ||
    /region\d+\.google-analytics\.com\/[gj]\/collect/.test(u) ||
    /analytics\.google\.com\/[gj]\/collect/.test(u) ||
    /region\d+\.analytics\.google\.com\/[gj]\/collect/.test(u) ||
    /stats\.g\.doubleclick\.net\/[gj]\/collect/.test(u) ||
    // Signature fallback — GA4 measurement protocol params
    /\/g\/collect\?[^"']*v=2[^"']*tid=g-/.test(u)
  );
}

/**
 * GA4 LIBRARY loader matcher. These are compliant pre-consent and must
 * be tracked separately for evidence display only.
 */
function isGa4Library(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return (
    /googletagmanager\.com\/gtag\/js/.test(u) ||
    /googletagmanager\.com\/gtag\/destination/.test(u)
  );
}

// Back-compat alias — callers that just want "is this a GA4-related URL"
// (e.g. legacy tests) can still use isGa4Request. It matches EITHER a hit
// or a library load. Counters must use isGa4Hit exclusively.
function isGa4Request(url) {
  return isGa4Hit(url) || isGa4Library(url);
}

/**
 * Parse the Google Consent Mode v2 `gcs` query param (e.g. "G100", "G101",
 * "G110", "G111"). Format is "G1" + ad_storage digit + analytics_storage digit
 * where 1 = granted and 0 = denied. Returns:
 *   { present: bool, cookielessDenied: bool, consented: bool, raw: string|null }
 * cookielessDenied = both storage digits are 0 (compliant Consent Mode ping).
 * consented = either storage digit is 1 (post-consent tracking).
 * If gcs is absent we cannot know — treated as "unknown consent".
 */
function parseConsentSignal(url) {
  const out = { present: false, cookielessDenied: false, consented: false, raw: null, gcd: null };
  if (!url || typeof url !== 'string') return out;
  try {
    // URL constructor is fine for http/https strings; ignore parse errors.
    const u = new URL(url);
    const gcs = u.searchParams.get('gcs');
    const gcd = u.searchParams.get('gcd');
    if (gcd) out.gcd = gcd;
    if (!gcs) return out;
    out.present = true;
    out.raw = gcs;
    const m = /^G1([01])([01])/i.exec(gcs);
    if (m) {
      const ad = m[1] === '1';
      const an = m[2] === '1';
      out.consented = ad || an;
      out.cookielessDenied = !ad && !an;
    }
  } catch (_) { /* ignore */ }
  return out;
}

/**
 * Google Ads / DoubleClick HIT matcher. Covers conversion, remarketing,
 * viewthrough, floodlight, and DCM endpoints. Excludes LIBRARY loads
 * (adsbygoogle.js and other /pagead/js scripts) — those are matched by
 * isAdsLibrary and MUST NOT be counted as Ads events. Counters must use
 * isAdsHit exclusively; isAdsRequest is a back-compat alias only.
 */
function isAdsHit(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  // Explicitly exclude library loads so a bare googlesyndication match
  // below doesn't sweep them in.
  if (isAdsLibrary(url)) return false;
  return (
    /googleadservices\.com\/pagead\/conversion/.test(u) ||
    /googleadservices\.com\/pagead\/1p-conversion/.test(u) ||
    /googleadservices\.com\/pagead\/1p-user-list/.test(u) ||
    /googleads\.g\.doubleclick\.net/.test(u) ||           // includes viewthroughconversion
    /cm\.g\.doubleclick\.net/.test(u) ||                  // floodlight cookie matching
    /ad\.doubleclick\.net/.test(u) ||
    /stats\.g\.doubleclick\.net\/dc\//.test(u) ||         // DCM
    /googlesyndication\.com/.test(u)
  );
}

/**
 * Google Ads / AdSense LIBRARY loader matcher. adsbygoogle.js and other
 * /pagead/js scripts served from googlesyndication or doubleclick are
 * script bootstraps — loading them pre-consent is compliant behaviour and
 * must never trigger a violation counter.
 */
function isAdsLibrary(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return (
    /pagead2\.googlesyndication\.com\/pagead\/js\//.test(u) ||
    /googlesyndication\.com\/pagead\/js\//.test(u) ||
    /adsbygoogle\.js/.test(u) ||
    /googleads\.g\.doubleclick\.net\/pagead\/(id|id-type)/.test(u)
  );
}

// Back-compat alias: matches EITHER a hit OR a library load. Counters must
// use isAdsHit exclusively.
function isAdsRequest(url) {
  return isAdsHit(url) || isAdsLibrary(url);
}

/**
 * GTM matcher.
 */
function isGtmRequest(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return /googletagmanager\.com\/gtm\.js/.test(u) || /\bgtm-[a-z0-9]{4,10}\b/.test(u);
}

/**
 * Detect WAF blocking or captcha challenges
 */
async function detectWafBlocking(page, response) {
  try {
    const httpStatus = response?.status() || 200;
    
    // Check HTTP status codes
    if ([401, 403, 503].includes(httpStatus)) {
      const pageData = await page.evaluate(() => {
        const title = document.title.toLowerCase();
        const bodyText = document.body?.innerText?.toLowerCase() || '';
        const html = document.documentElement.innerHTML.toLowerCase();
        
        const wafPatterns = [
          'access denied',
          'forbidden',
          'request blocked',
          'web application firewall',
          'checking your browser',
          'are you a robot',
          'captcha',
          'cloudflare',
          'incapsula',
          'akamai',
          'attention required',
          'bot protection',
          'security check'
        ];
        
        const hasWafPattern = wafPatterns.some(pattern => 
          title.includes(pattern) || bodyText.includes(pattern) || html.includes(pattern)
        );
        
        return {
          title,
          hasWafPattern,
          bodyLength: bodyText.length
        };
      });
      
      if (pageData.hasWafPattern || pageData.bodyLength < 500) {
        return {
          blocked: true,
          reason: `HTTP ${httpStatus} with WAF/bot detection patterns`
        };
      }
    }
    
    // Check for captcha elements
    const hasCaptcha = await page.evaluate(() => {
      const captchaSelectors = [
        '[class*="captcha"]',
        '[id*="captcha"]',
        'iframe[src*="recaptcha"]',
        'iframe[src*="hcaptcha"]',
        '.g-recaptcha',
        '#cf-challenge-running'
      ];
      
      return captchaSelectors.some(selector => document.querySelector(selector) !== null);
    });
    
    if (hasCaptcha) {
      return {
        blocked: true,
        reason: 'Captcha challenge detected'
      };
    }
    
    // Check for redirect challenges
    const pageContent = await page.evaluate(() => {
      const metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
      const jsChallenge = document.body?.innerHTML.toLowerCase().includes('jschl');
      return { metaRefresh: !!metaRefresh, jsChallenge };
    });
    
    if (pageContent.metaRefresh && pageContent.jsChallenge) {
      return {
        blocked: true,
        reason: 'JavaScript challenge redirect detected'
      };
    }
    
    return {
      blocked: false,
      reason: null
    };
    
  } catch (error) {
    console.error('[WAF Detection Error]:', error.message);
    return {
      blocked: false,
      reason: null
    };
  }
}

/**
 * Detect CMP and consent buttons on the page
 *
 * V2.1: iterates page.frames() so CMPs rendered inside iframes
 * (Sourcepoint, TrustArc, some OneTrust/Didomi deployments) are actually
 * found. Same-origin iframes are scripted; cross-origin frames throw on
 * evaluate — we catch that and, if the iframe URL matches a known CMP
 * pattern, record cmp.inIframe=true / cmp.crossOriginBlocked=true so
 * downstream can report "CMP in cross-origin iframe — interaction not
 * possible" instead of guessing.
 */
async function detectCmpAndButtons(page) {
  // In-frame scanner. Runs the ORIGINAL button-detection logic, unchanged,
  // inside whichever frame it is passed. Returns the same shape as before
  // plus a `hasButtons` convenience flag.
  const scanFrame = async (frame) => {
    return await frame.evaluate(() => {
      const html = document.documentElement.innerHTML.toLowerCase();
      const bodyText = document.body?.innerText?.toLowerCase() || '';

      const vendors = {
        'OneTrust': ['onetrust', 'ot-sdk-btn'],
        'Cookiebot': ['cookiebot', 'cookieconsent'],
        'Usercentrics': ['usercentrics', 'uc-'],
        'Didomi': ['didomi', 'didomi-consent'],
        'Quantcast': ['quantcast', 'qc-cmp'],
        'TrustArc': ['trustarc', 'truste'],
        'Osano': ['osano'],
        'Termly': ['termly'],
        'Sourcepoint': ['sp_message_iframe', 'sourcepoint', 'sp-message']
      };

      let detectedVendor = null;
      for (const [vendor, patterns] of Object.entries(vendors)) {
        if (patterns.some(p => html.includes(p))) { detectedVendor = vendor; break; }
      }

      const hasCmpMarkers = html.includes('cookie') &&
        (html.includes('consent') || html.includes('banner') || html.includes('accept'));
      if (!detectedVendor && hasCmpMarkers) detectedVendor = 'Custom or unknown';

      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));

      const rejectPatterns = [
        'accept only essential', 'accept only necessary', 'accept essential only',
        'only necessary', 'only essential', 'necessary only', 'essential only',
        'necessary cookies only', 'essential cookies only',
        'reject all', 'reject', 'decline all', 'decline', 'deny all', 'deny',
        'refuse all', 'refuse',
        'ablehnen', 'alle ablehnen', 'refuser', 'refuser tout',
        'continue without accepting', 'dismiss',
      ];
      const acceptPatterns = [
        'accept all', 'accept cookies', 'accept', 'agree', 'allow all', 'allow',
        'akzeptieren', 'alle akzeptieren', 'tout accepter', 'accepter',
      ];
      const containsReject = (s) => rejectPatterns.some(p => s.includes(p));
      const containsAccept = (s) => acceptPatterns.some(p => s.includes(p));

      let acceptButton = null;
      let rejectButton = null;
      let bannerText = '';

      for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || '').toLowerCase().trim();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const fullText = `${text} ${ariaLabel}`;
        const isReject = containsReject(fullText);
        const isAccept = containsAccept(fullText);

        let classified = null;
        if (isReject && !isAccept) classified = 'reject';
        else if (isAccept && !isReject) classified = 'accept';
        else if (isReject && isAccept) {
          const hasAll = /\ball\b/.test(fullText);
          const hasReducedToken = /(only|essential|necessary)/.test(fullText);
          classified = hasAll && !hasReducedToken ? 'accept' : 'reject';
        }

        if (classified === 'reject' && !rejectButton) rejectButton = { text: text.substring(0, 50) };
        else if (classified === 'accept' && !acceptButton) acceptButton = { text: text.substring(0, 50) };

        if (bannerText.length < 200 && text.includes('cookie')) {
          bannerText += text.substring(0, 100) + ' ';
        }
      }

      return {
        detected: !!detectedVendor,
        vendor: detectedVendor,
        bannerTextSample: bannerText.trim().substring(0, 200) || null,
        hasAcceptAll: !!acceptButton,
        hasRejectAll: !!rejectButton,
        acceptButtonText: acceptButton?.text || null,
        rejectButtonText: rejectButton?.text || null,
        hasButtons: !!(acceptButton || rejectButton),
      };
    });
  };

  // Known CMP-iframe URL patterns — used to detect a CMP living in a
  // cross-origin iframe that we cannot script.
  const CMP_IFRAME_URL_PATTERNS = [
    /sourcepoint/i, /sp_message_iframe/i, /sp-prod/i, /wrapper-api/i,
    /trustarc/i, /consent\.trustarc/i,
    /privacy-mgmt/i, /consent-manager/i, /consent\-cdn/i,
    /cookiepro/i, /onetrust\.com/i, /cdn\.cookielaw\.org.*iframe/i,
    /didomi\.io.*consent/i,
  ];

  const empty = {
    detected: false, vendor: null, bannerTextSample: null,
    hasAcceptAll: false, hasRejectAll: false,
    acceptButtonText: null, rejectButtonText: null,
    buttonsFrameUrl: null, inIframe: false, crossOriginBlocked: false,
  };

  try {
    const frames = page.frames();
    const topFrame = page.mainFrame();

    // 1) Try top frame first.
    let topResult = null;
    try { topResult = await scanFrame(topFrame); } catch (_) { topResult = null; }

    // 2) Walk child frames, prefer any that yields buttons.
    let iframeMatch = null;      // { result, frameUrl }
    let crossOriginCmp = null;   // { frameUrl }
    for (const f of frames) {
      if (f === topFrame) continue;
      const frameUrl = (() => { try { return f.url(); } catch { return ''; } })();
      try {
        const r = await scanFrame(f);
        if (r && (r.hasButtons || r.detected)) {
          if (!iframeMatch && r.hasButtons) iframeMatch = { result: r, frameUrl };
          // Merge vendor into top result if top didn't detect one.
          if (topResult && !topResult.vendor && r.vendor) topResult.vendor = r.vendor;
          if (topResult) topResult.detected = topResult.detected || r.detected;
        }
      } catch (_) {
        // Cross-origin frame — record only if URL looks like a CMP iframe.
        if (frameUrl && CMP_IFRAME_URL_PATTERNS.some((rx) => rx.test(frameUrl))) {
          if (!crossOriginCmp) crossOriginCmp = { frameUrl };
        }
      }
    }

    // Decide which result to return. Prefer top-frame buttons; else iframe
    // buttons; else top-frame vendor detection with cross-origin annotation.
    if (topResult && topResult.hasButtons) {
      return { ...topResult, buttonsFrameUrl: null, inIframe: false, crossOriginBlocked: false };
    }
    if (iframeMatch) {
      return {
        ...iframeMatch.result,
        buttonsFrameUrl: iframeMatch.frameUrl,
        inIframe: true,
        crossOriginBlocked: false,
      };
    }
    if (crossOriginCmp) {
      const base = topResult || empty;
      return {
        ...base,
        detected: true,
        vendor: base.vendor || 'Unknown (cross-origin iframe)',
        hasAcceptAll: false,
        hasRejectAll: false,
        acceptButtonText: null,
        rejectButtonText: null,
        buttonsFrameUrl: crossOriginCmp.frameUrl,
        inIframe: true,
        crossOriginBlocked: true,
      };
    }
    // No buttons anywhere — return top-frame result (which may still have
    // detected a vendor via HTML markers).
    return { ...(topResult || empty), buttonsFrameUrl: null, inIframe: false, crossOriginBlocked: false };
  } catch (error) {
    console.error('[CMP Detection Error]:', error.message);
    return empty;
  }
}

/**
 * Detect Consent Mode v2 state
 */
async function detectConsentModeState(page) {
  try {
    const consentState = await page.evaluate(() => {
      // Check dataLayer for consent signals
      const dataLayer = window.dataLayer || [];
      
      let ad_storage = null;
      let analytics_storage = null;
      let ad_user_data = null;
      let ad_personalization = null;
      let signalsDetected = [];
      
      // Look through dataLayer for consent commands
      for (const item of dataLayer) {
        if (item && typeof item === 'object') {
          // Check for gtag consent objects
          if (item[0] === 'consent' && item[2]) {
            const consent = item[2];
            if (consent.ad_storage) {
              ad_storage = consent.ad_storage;
              signalsDetected.push('ad_storage');
            }
            if (consent.analytics_storage) {
              analytics_storage = consent.analytics_storage;
              signalsDetected.push('analytics_storage');
            }
            if (consent.ad_user_data) {
              ad_user_data = consent.ad_user_data;
              signalsDetected.push('ad_user_data');
            }
            if (consent.ad_personalization) {
              ad_personalization = consent.ad_personalization;
              signalsDetected.push('ad_personalization');
            }
          }
          
          // Also check direct properties
          if (item.ad_storage) ad_storage = item.ad_storage;
          if (item.analytics_storage) analytics_storage = item.analytics_storage;
          if (item.ad_user_data) ad_user_data = item.ad_user_data;
          if (item.ad_personalization) ad_personalization = item.ad_personalization;
        }
      }
      
      // Check scripts for consent mode patterns
      const scripts = Array.from(document.querySelectorAll('script'));
      const scriptContent = scripts.map(s => s.textContent || '').join(' ');
      
      if (scriptContent.includes('gtag') && scriptContent.includes('consent')) {
        if (scriptContent.includes('ad_storage') && !signalsDetected.includes('ad_storage')) {
          signalsDetected.push('ad_storage');
          ad_storage = ad_storage || 'unknown';
        }
        if (scriptContent.includes('analytics_storage') && !signalsDetected.includes('analytics_storage')) {
          signalsDetected.push('analytics_storage');
          analytics_storage = analytics_storage || 'unknown';
        }
        if (scriptContent.includes('ad_user_data') && !signalsDetected.includes('ad_user_data')) {
          signalsDetected.push('ad_user_data');
          ad_user_data = ad_user_data || 'unknown';
        }
        if (scriptContent.includes('ad_personalization') && !signalsDetected.includes('ad_personalization')) {
          signalsDetected.push('ad_personalization');
          ad_personalization = ad_personalization || 'unknown';
        }
      }

      // ENHANCED (V2 overhaul): also inspect GTM's internal consent store,
      // gtag's queue, and CMP interop hooks (TCF / USP). When GTM loads GA4
      // dynamically, consent defaults frequently never hit window.dataLayer.
      try {
        const gtd = window.google_tag_data;
        const entries = gtd && gtd.ics && gtd.ics.entries;
        if (entries && typeof entries === 'object') {
          for (const key of Object.keys(entries)) {
            if (!signalsDetected.includes(key)) signalsDetected.push(key);
            const v = entries[key];
            if (key === 'ad_storage' && !ad_storage) ad_storage = (v && v.default) || 'unknown';
            if (key === 'analytics_storage' && !analytics_storage) analytics_storage = (v && v.default) || 'unknown';
            if (key === 'ad_user_data' && !ad_user_data) ad_user_data = (v && v.default) || 'unknown';
            if (key === 'ad_personalization' && !ad_personalization) ad_personalization = (v && v.default) || 'unknown';
          }
        }
      } catch (_) { /* ignore */ }

      try {
        const q = window.gtag && window.gtag.q;
        if (Array.isArray(q)) {
          for (const tuple of q) {
            if (Array.isArray(tuple) && tuple[0] === 'consent' && tuple[2]) {
              const c = tuple[2];
              if (c.ad_storage && !ad_storage) { ad_storage = c.ad_storage; signalsDetected.push('ad_storage'); }
              if (c.analytics_storage && !analytics_storage) { analytics_storage = c.analytics_storage; signalsDetected.push('analytics_storage'); }
              if (c.ad_user_data && !ad_user_data) { ad_user_data = c.ad_user_data; signalsDetected.push('ad_user_data'); }
              if (c.ad_personalization && !ad_personalization) { ad_personalization = c.ad_personalization; signalsDetected.push('ad_personalization'); }
            }
          }
        }
      } catch (_) { /* ignore */ }

      const tcfPresent = typeof window.__tcfapi === 'function';
      const uspPresent = typeof window.__uspapi === 'function';

      return {
        ad_storage,
        analytics_storage,
        ad_user_data,
        ad_personalization,
        signalsDetected: [...new Set(signalsDetected)],
        tcfPresent,
        uspPresent,
      };
    });
    
    return consentState;
  } catch (error) {
    console.error('[Consent Mode Detection Error]:', error.message);
    return {
      ad_storage: null,
      analytics_storage: null,
      ad_user_data: null,
      ad_personalization: null,
      signalsDetected: [],
      tcfPresent: false,
      uspPresent: false,
    };
  }
}

/**
 * Capture data layer events
 */
async function captureDataLayerEvents(page) {
  try {
    const events = await page.evaluate(() => {
      const dataLayer = window.dataLayer || [];
      
      return dataLayer.slice(0, 20).map(item => {
        if (!item || typeof item !== 'object') return null;
        
        return {
          event: item.event || item[0] || null,
          event_category: item.event_category || null,
          event_action: item.event_action || null,
          event_label: item.event_label || null,
          consent_related: item.consent || item.ad_storage || item.analytics_storage || null
        };
      }).filter(e => e !== null);
    });
    
    return events;
  } catch (error) {
    return [];
  }
}

/**
 * Capture screenshot as base64
 */
async function captureScreenshot(page) {
  try {
    const screenshot = await page.screenshot({
      encoding: 'base64',
      type: 'png',
      fullPage: false,
      clip: {
        x: 0,
        y: 0,
        width: 1366,
        height: 768
      }
    });
    return `data:image/png;base64,${screenshot}`;
  } catch (error) {
    console.error('[Screenshot Error]:', error.message);
    return null;
  }
}

/**
 * Run a single browser flow with full tracking
 */
async function runFlow(browser, url, flowName, maxWaitMs) {
  const startTime = Date.now();
  let context = null;
  let page = null;
  
  try {
    // Create incognito context for isolation
    context = await browser.createIncognitoBrowserContext();
    page = await context.newPage();
    
    // Set realistic desktop environment
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-GB,en;q=0.9,de;q=0.8'
    });
    
    // Track network requests
    const networkSummary = {
      ga4Requests: [],
      adsRequests: [],
      gtmRequests: [],
      otherTracking: [],
      ga4LibraryLoads: [],
      adsLibraryLoads: [],
      // Per-hit consent classification (populated below)
      ga4Consented: 0,
      ga4Cookieless: 0,
      ga4UnknownConsent: 0,
      adsConsented: 0,
      adsCookieless: 0,
      adsUnknownConsent: 0,
    };
    
    page.on('request', request => {
      const url = request.url();

      if (isGa4Hit(url)) {
        const cs = parseConsentSignal(url);
        networkSummary.ga4Requests.push({
          url: url.substring(0, 150),
          method: request.method(),
          gcs: cs.raw,
          gcd: cs.gcd,
          ts: Date.now(),
          consentClass: cs.cookielessDenied ? 'cookieless_denied'
                        : cs.consented ? 'consented'
                        : cs.present ? 'consented'   // gcs present but unparsed → treat as consented
                        : 'unknown',
        });
        if (cs.cookielessDenied) networkSummary.ga4Cookieless++;
        else if (cs.present) networkSummary.ga4Consented++;
        else networkSummary.ga4UnknownConsent++;
      } else if (isGa4Library(url)) {
        // Library load — compliant pre-consent, evidence only.
        networkSummary.ga4LibraryLoads.push({ url: url.substring(0, 150), method: request.method() });
      } else if (isAdsHit(url)) {
        const cs = parseConsentSignal(url);
        networkSummary.adsRequests.push({
          url: url.substring(0, 150),
          method: request.method(),
          gcs: cs.raw,
          gcd: cs.gcd,
          ts: Date.now(),
          consentClass: cs.cookielessDenied ? 'cookieless_denied'
                        : cs.consented ? 'consented'
                        : cs.present ? 'consented'
                        : 'unknown',
        });
        if (cs.cookielessDenied) networkSummary.adsCookieless++;
        else if (cs.present) networkSummary.adsConsented++;
        else networkSummary.adsUnknownConsent++;
      } else if (isAdsLibrary(url)) {
        // Ads library load (adsbygoogle.js etc.) — evidence only, never a hit.
        networkSummary.adsLibraryLoads.push({ url: url.substring(0, 150), method: request.method() });
      } else if (isGtmRequest(url)) {
        networkSummary.gtmRequests.push({ url: url.substring(0, 150), method: request.method() });
      } else if (
        url.includes('facebook.com/tr') ||
        url.includes('connect.facebook.net') ||
        url.includes('analytics') ||
        url.includes('tracking')
      ) {
        networkSummary.otherTracking.push({ url: url.substring(0, 100), method: request.method() });
      }
    });
    
    // Navigate to URL
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 10000
    });
    
    const httpStatus = response?.status() || null;
    const finalUrl = page.url();

    // GEO-REDIRECT detection (Problem 5). Flag when the live URL ends up on a
    // meaningfully different host than the user requested — e.g. gymshark.com
    // → us.checkout.gymshark.com. The orchestrator surfaces this to the UI.
    let geoRedirect = false;
    let geoRedirectReason = null;
    try {
      const orig = new URL(url).hostname.toLowerCase();
      const finalHost = new URL(finalUrl).hostname.toLowerCase();
      if (orig && finalHost && orig !== finalHost) {
        const origTld = orig.split('.').slice(-1)[0];
        const finalTld = finalHost.split('.').slice(-1)[0];
        const subPrefixes = ['checkout.', 'cart.', 'account.'];
        const regionPrefixes = ['us.', 'de.', 'fr.', 'eu.', 'uk.', 'au.', 'ca.', 'jp.', 'es.', 'it.', 'nl.'];
        if (origTld !== finalTld) {
          geoRedirect = true;
          geoRedirectReason = `TLD changed (${origTld} → ${finalTld})`;
        } else if (subPrefixes.some(p => finalHost.startsWith(p))) {
          geoRedirect = true;
          geoRedirectReason = `Redirected to ${finalHost.split('.')[0]} subdomain (${finalHost})`;
        } else {
          const finalPrefix = regionPrefixes.find(p => finalHost.startsWith(p));
          const origPrefix = regionPrefixes.find(p => orig.startsWith(p));
          if (finalPrefix && finalPrefix !== origPrefix) {
            geoRedirect = true;
            geoRedirectReason = `Geo redirect to ${finalHost}`;
          }
        }
      }
    } catch (_) { /* ignore URL parse errors */ }
    
    // Detect WAF blocking
    const wafStatus = await detectWafBlocking(page, response);
    
    // If blocked by WAF, return early with minimal data
    if (wafStatus.blocked) {
      const duration = Date.now() - startTime;
      return {
        flowName,
        success: false,
        duration,
        finalUrl,
        httpStatus,
        wafBlocked: true,
        wafReason: wafStatus.reason,
        geoRedirect,
        geoRedirectReason,
        error: 'Site blocked by WAF or captcha',
        timestamp: new Date().toISOString()
      };
    }
    
    // Wait for dynamic content
    await page.waitForTimeout(1500);
    
    // Capture screenshot before interaction
    const screenshotBefore = await captureScreenshot(page);
    
    // Detect CMP
    const cmpData = await detectCmpAndButtons(page);
    
    // Capture initial consent mode state
    const consentModeBefore = await detectConsentModeState(page);

    // ====== PRE-CONSENT SNAPSHOT ======
    // Snapshot before any banner click. Pre-consent VIOLATION counts exclude
    // cookieless Consent Mode v2 pings (gcs=G100 with both storage denied),
    // which are compliant behaviour and must not raise a violation. Library
    // loads (gtag.js) are already excluded because they never enter
    // ga4Requests. See parseConsentSignal / isGa4Library above.
    const preConsentGa4Count =
      networkSummary.ga4Requests.length - networkSummary.ga4Cookieless;
    const preConsentAdsCount =
      networkSummary.adsRequests.length - networkSummary.adsCookieless;
    const preConsentGtmCount = networkSummary.gtmRequests.length;
    const preConsentGa4CookielessCount = networkSummary.ga4Cookieless;
    const preConsentAdsCookielessCount = networkSummary.adsCookieless;
    
    // Execute flow-specific action
    let actionTaken = null;
    // Timestamp of a successful accept/reject click. Used to distinguish
    // post-click hits from page-load hits — since each flow is a fresh
    // page load, ga4EventsCount alone includes hits that fired BEFORE the
    // click and cannot be treated as "leak after reject" evidence.
    let clickTimestamp = null;
    // Resolve the frame where the CMP buttons live. If detectCmpAndButtons
    // found them in a child iframe, look it up by URL; otherwise use the
    // top frame.
    const resolveButtonFrame = () => {
      if (cmpData.inIframe && cmpData.buttonsFrameUrl) {
        try {
          const f = page.frames().find((fr) => {
            try { return fr.url() === cmpData.buttonsFrameUrl; } catch { return false; }
          });
          if (f) return f;
        } catch (_) { /* ignore */ }
      }
      return page.mainFrame();
    };

    if (flowName === 'preConsent') {
      actionTaken = 'No interaction (preConsent flow — measures hits fired before any banner action)';
    } else if ((flowName === 'acceptAll' || flowName === 'rejectAll') && cmpData.crossOriginBlocked) {
      actionTaken = `CMP iframe cross-origin — could not interact (${cmpData.buttonsFrameUrl || 'unknown iframe'})`;
    } else if (flowName === 'acceptAll' && cmpData.hasAcceptAll && cmpData.acceptButtonText) {
      try {
        const acceptText = cmpData.acceptButtonText.toLowerCase();
        const targetFrame = resolveButtonFrame();
        const clicked = await targetFrame.evaluate((targetText) => {
          const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          const btn = buttons.find(b => {
            const t = (b.innerText || b.textContent || '').toLowerCase().trim();
            return t.includes(targetText) || targetText.includes(t.substring(0, 20));
          });
          if (btn) { btn.click(); return true; }
          return false;
        }, acceptText);
        const where = cmpData.inIframe
          ? ` in iframe (${cmpData.buttonsFrameUrl})`
          : '';
        actionTaken = clicked
          ? `Clicked accept${where}: ${cmpData.acceptButtonText}`
          : `Accept button not found in DOM${where}: ${cmpData.acceptButtonText}`;
        if (clicked) clickTimestamp = Date.now();
        await page.waitForTimeout(2000);
        await page.waitForNetworkIdle({ timeout: 3000 }).catch(() => {});
      } catch (clickError) {
        actionTaken = `Failed to click accept: ${clickError.message}`;
      }
    } else if (flowName === 'rejectAll' && cmpData.hasRejectAll && cmpData.rejectButtonText) {
      try {
        const rejectText = cmpData.rejectButtonText.toLowerCase();
        const targetFrame = resolveButtonFrame();
        const clicked = await targetFrame.evaluate((targetText) => {
          const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          const btn = buttons.find(b => {
            const t = (b.innerText || b.textContent || '').toLowerCase().trim();
            return t.includes(targetText) || targetText.includes(t.substring(0, 20));
          });
          if (btn) { btn.click(); return true; }
          return false;
        }, rejectText);
        const where = cmpData.inIframe
          ? ` in iframe (${cmpData.buttonsFrameUrl})`
          : '';
        actionTaken = clicked
          ? `Clicked reject${where}: ${cmpData.rejectButtonText}`
          : `Reject button not found in DOM${where}: ${cmpData.rejectButtonText}`;
        if (clicked) clickTimestamp = Date.now();
        await page.waitForTimeout(2000);
        await page.waitForNetworkIdle({ timeout: 3000 }).catch(() => {});
      } catch (clickError) {
        actionTaken = `Failed to click reject: ${clickError.message}`;
      }
    } else if (flowName === 'baseline') {
      actionTaken = 'No interaction (baseline flow)';
    } else {
      actionTaken = `Button not found for ${flowName}`;
    }
    
    // Capture final consent mode state
    const consentModeAfter = await detectConsentModeState(page);
    
    // Capture data layer
    const dataLayerEvents = await captureDataLayerEvents(page);
    
    // Capture screenshot after interaction
    const screenshotAfter = (flowName !== 'baseline' && flowName !== 'preConsent')
      ? await captureScreenshot(page) : null;
    
    const duration = Date.now() - startTime;

    // Post-click counters. For acceptAll/rejectAll flows, separate hits that
    // fired AFTER the successful click from page-load hits. When no click
    // happened (button not found, cross-origin iframe, click failed), emit
    // null (UNVERIFIED) — never 0, which would falsely imply the site was
    // silent after the action.
    const isClickFlow = flowName === 'acceptAll' || flowName === 'rejectAll';
    let postClickGa4Count = null;
    let postClickAdsCount = null;
    let postClickGa4CookielessCount = null;
    let postClickAdsCookielessCount = null;
    if (isClickFlow) {
      if (clickTimestamp != null) {
        const afterGa4 = networkSummary.ga4Requests.filter(r => typeof r.ts === 'number' && r.ts > clickTimestamp);
        const afterAds = networkSummary.adsRequests.filter(r => typeof r.ts === 'number' && r.ts > clickTimestamp);
        postClickGa4Count = afterGa4.filter(r => r.consentClass !== 'cookieless_denied').length;
        postClickAdsCount = afterAds.filter(r => r.consentClass !== 'cookieless_denied').length;
        postClickGa4CookielessCount = afterGa4.filter(r => r.consentClass === 'cookieless_denied').length;
        postClickAdsCookielessCount = afterAds.filter(r => r.consentClass === 'cookieless_denied').length;
      }
      // else: click never happened → leave all four as null (unverified).
    }
    
    return {
      flowName,
      success: true,
      duration,
      finalUrl,
      httpStatus,
      wafBlocked: false,
      geoRedirect,
      geoRedirectReason,
      actionTaken,
      clickTimestamp,
      cmp: cmpData,
      tracking: {
        ga4Detected: networkSummary.ga4Requests.length > 0,
        ga4EventsCount: networkSummary.ga4Requests.length,
        adsDetected: networkSummary.adsRequests.length > 0,
        adsEventsCount: networkSummary.adsRequests.length,
        gtmDetected: networkSummary.gtmRequests.length > 0,
        gtmEventsCount: networkSummary.gtmRequests.length,
        // Pre-consent snapshot — captured before any accept/reject click.
        preConsentGa4Count,
        preConsentAdsCount,
        preConsentGtmCount,
        preConsentGa4CookielessCount,
        preConsentAdsCookielessCount,
        // Post-click counters. NULL means the click never happened (button
        // not found / cross-origin iframe) — treat as UNVERIFIED downstream,
        // NOT as zero.
        postClickGa4Count,
        postClickAdsCount,
        postClickGa4CookielessCount,
        postClickAdsCookielessCount,
        // Per-flow consent classification (evidence for UI).
        ga4ConsentedCount: networkSummary.ga4Consented,
        ga4CookielessCount: networkSummary.ga4Cookieless,
        ga4UnknownConsentCount: networkSummary.ga4UnknownConsent,
        adsConsentedCount: networkSummary.adsConsented,
        adsCookielessCount: networkSummary.adsCookieless,
        adsUnknownConsentCount: networkSummary.adsUnknownConsent,
        ga4LibraryLoads: networkSummary.ga4LibraryLoads.length,
        adsLibraryLoads: networkSummary.adsLibraryLoads.length,
        networkSummary: {
          ga4Requests: networkSummary.ga4Requests.slice(0, 10),
          adsRequests: networkSummary.adsRequests.slice(0, 10),
          gtmRequests: networkSummary.gtmRequests.slice(0, 10),
          otherTracking: networkSummary.otherTracking.slice(0, 5)
        }
      },
      consentMode: {
        before: consentModeBefore,
        after: consentModeAfter
      },
      dataLayerEvents: dataLayerEvents.slice(0, 15),
      screenshots: {
        before: screenshotBefore,
        after: screenshotAfter
      },
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    return {
      flowName,
      success: false,
      duration,
      error: error.message,
      timestamp: new Date().toISOString()
    };
    
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

/**
 * Analyze server-side tracking heuristics
 */
function analyzeServerSideTracking(cmp, consentMode, flows, url) {
  const heuristics = [];
  
  // Check if any GA4 or Ads requests were detected in any flow
  const hasGA4 = flows.baseline?.tracking?.ga4EventsCount > 0 || 
                 flows.acceptAll?.tracking?.ga4EventsCount > 0 ||
                 flows.rejectAll?.tracking?.ga4EventsCount > 0;
  
  const hasAds = flows.baseline?.tracking?.adsEventsCount > 0 || 
                 flows.acceptAll?.tracking?.adsEventsCount > 0 ||
                 flows.rejectAll?.tracking?.adsEventsCount > 0;
  
  // Extract hostname from URL
  let hostname = '';
  try {
    const urlObj = new URL(url);
    hostname = urlObj.hostname.toLowerCase();
  } catch {
    hostname = url.toLowerCase();
  }
  
  // Known enterprise/global brand domains that commonly use server-side tracking
  const enterpriseDomains = [
    'zalando', 'lidl', 'adidas', 'nike', 'asos', 'h&m', 'hm', 'zara',
    'decathlon', 'ikea', 'uniqlo', 'otto', 'aboutyou', 'mediamarkt',
    'booking', 'allbirds', 'gymshark', 'target', 'bbc', 'bathandbodyworks',
    'purelei', 'snagtights', 'auvodka', 'swiss', 'euronews', 'theguardian',
    'lemonde', 'elconfidencial', 'amazon', 'stripe', 'hubspot', 'zendesk'
  ];
  
  const isEnterpriseDomain = enterpriseDomains.some(domain => 
    hostname.includes(domain)
  );
  
  // Hostname complexity heuristic: shorter hostnames often belong to large brands
  // e.g., nike.com, asos.com, ikea.com vs. myblogsite123.wordpress.com
  const isComplexDomain = hostname.replace(/\.(com|co\.uk|de|fr|eu|net|org)$/, '').length < 12;
  
  // Check if Consent Mode is missing or only partially implemented
  const consentModeMissingOrPartial = !consentMode?.implemented || 
                                      (consentMode?.signalsDetected?.length < 4);
  
  // CASE 1: CMP detected + No GA4/Ads + Large brand + No/Partial Consent Mode
  // → Likely server-side tracking
  if (cmp?.detected && !hasGA4 && !hasAds && (isEnterpriseDomain || isComplexDomain) && consentModeMissingOrPartial) {
    heuristics.push('CMP detected but no GA4/Ads requests fired client-side');
    heuristics.push('Likely server-side or proxy-based tracking in use');
    
    return {
      possibleServerSideTracking: true,
      serverSideHeuristics: heuristics,
      trackingSummary: 'No client-side GA4/Ads detected. Server-side tracking likely.'
    };
  }
  
  // CASE 2: CMP detected + No GA4/Ads + NOT a large brand
  // → Just acknowledge no client-side tracking, don't claim "low risk"
  if (cmp?.detected && !hasGA4 && !hasAds) {
    heuristics.push('CMP detected but no GA4/Ads requests fired client-side');
    
    return {
      possibleServerSideTracking: false,
      serverSideHeuristics: heuristics,
      trackingSummary: 'No client-side GA4/Ads detected.'
    };
  }
  
  // CASE 3: NO CMP + No GA4/Ads
  // → Genuinely low tracking/low risk
  if (!cmp?.detected && !hasGA4 && !hasAds) {
    return {
      possibleServerSideTracking: false,
      serverSideHeuristics: [],
      trackingSummary: 'No client-side tracking detected and no CMP present. Low tracking.'
    };
  }
  
  // Default case: Some tracking detected, standard analysis
  if (consentMode?.implemented && consentMode?.signalsDetected?.length > 0 && !hasGA4 && !hasAds) {
    heuristics.push('Consent Mode signals present but no GA4/Ads requests observed');
  }
  
  const possibleServerSide = heuristics.length > 0;
  
  return {
    possibleServerSideTracking: possibleServerSide,
    serverSideHeuristics: heuristics,
    trackingSummary: null
  };
}

/**
 * Main scanner entry point - runs all flows sequentially
 */
async function runJsScanV2({ url, maxWaitMs = 10000 }) {
  const TOTAL_SCAN_TIMEOUT = 80000; // 80 seconds hard limit
  const scanStartTime = Date.now();
  let browser = null;
  
  try {
    console.log(`[JS-SCAN] Starting scan for: ${url}`);
    
    // Launch browser with enterprise settings
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled'
      ]
    });
    
    // Run flows SEQUENTIALLY to avoid interference.
    // V2: a dedicated preConsent flow runs FIRST — it measures GA4/Ads hits
    // fired before any banner interaction (the most severe violation class).
    console.log('[JS-SCAN] Running preConsent flow...');
    const preConsent = await runFlow(browser, url, 'preConsent', maxWaitMs);

    console.log('[JS-SCAN] Running baseline flow...');
    const baseline = await runFlow(browser, url, 'baseline', maxWaitMs);
    
    // Check if approaching timeout
    const elapsedTime = Date.now() - scanStartTime;
    if (elapsedTime > TOTAL_SCAN_TIMEOUT - 20000) {
      console.log('[JS-SCAN] Approaching timeout, returning partial results');
      return {
        url,
        status: 'partial',
        errorMessage: 'Scan timeout - partial results returned',
        meta: {
          finalUrl: baseline.finalUrl || url,
          httpStatus: baseline.httpStatus,
          timestamp: new Date().toISOString(),
          userAgent: 'Chrome/120.0.0.0',
          totalDuration: elapsedTime
        },
        waf: {
          blocked: false,
          reason: null
        },
        cmp: baseline.cmp || null,
        consentMode: {
          implemented: false,
          signalsDetected: [],
          defaultState: baseline.consentMode?.before || null
        },
        tracking: {
          flows: {
            baseline: {
              tracking: baseline.tracking,
              dataLayerEvents: baseline.dataLayerEvents,
              actionTaken: baseline.actionTaken
            }
          }
        }
      };
    }
    
    // Check if WAF blocked baseline - if so, return early
    if (baseline.wafBlocked) {
      console.log('[JS-SCAN] Site blocked by WAF');
      return {
        url,
        status: 'blocked_waf',
        errorMessage: baseline.error || 'Site blocked by WAF or captcha',
        meta: {
          finalUrl: baseline.finalUrl || url,
          httpStatus: baseline.httpStatus,
          timestamp: new Date().toISOString(),
          userAgent: 'Chrome/120.0.0.0'
        },
        waf: {
          blocked: true,
          reason: baseline.wafReason || 'WAF or captcha detected'
        }
      };
    }
    
    console.log('[JS-SCAN] Running acceptAll flow...');
    const acceptAll = await runFlow(browser, url, 'acceptAll', maxWaitMs);
    
    // Check if approaching timeout after acceptAll
    const elapsedAfterAccept = Date.now() - scanStartTime;
    if (elapsedAfterAccept > TOTAL_SCAN_TIMEOUT - 20000) {
      console.log('[JS-SCAN] Approaching timeout after acceptAll, skipping rejectAll');
      const cmp = baseline.cmp || acceptAll.cmp;
      const allSignals = [
        ...(baseline.consentMode?.before?.signalsDetected || []),
        ...(acceptAll.consentMode?.before?.signalsDetected || [])
      ];
      const uniqueSignals = [...new Set(allSignals)];
      
      return {
        url,
        status: 'partial',
        errorMessage: 'Scan timeout - rejectAll flow skipped',
        meta: {
          finalUrl: baseline.finalUrl || url,
          httpStatus: baseline.httpStatus,
          timestamp: new Date().toISOString(),
          userAgent: 'Chrome/120.0.0.0',
          totalDuration: elapsedAfterAccept
        },
        waf: {
          blocked: false,
          reason: null
        },
        cmp,
        consentMode: {
          implemented: uniqueSignals.length > 0,
          signalsDetected: uniqueSignals,
          defaultState: baseline.consentMode?.before || null,
          acceptAllState: acceptAll.consentMode?.after || null
        },
        tracking: {
          flows: {
            baseline: {
              tracking: baseline.tracking,
              dataLayerEvents: baseline.dataLayerEvents,
              actionTaken: baseline.actionTaken
            },
            acceptAll: {
              tracking: acceptAll.tracking,
              dataLayerEvents: acceptAll.dataLayerEvents,
              actionTaken: acceptAll.actionTaken
            }
          }
        }
      };
    }
    
    console.log('[JS-SCAN] Running rejectAll flow...');
    const rejectAll = await runFlow(browser, url, 'rejectAll', maxWaitMs);
    
    // Aggregate results
    const cmp = baseline.cmp || acceptAll.cmp || rejectAll.cmp;
    
    // Determine if Consent Mode is implemented
    const allSignals = [
      ...(baseline.consentMode?.before?.signalsDetected || []),
      ...(acceptAll.consentMode?.before?.signalsDetected || []),
      ...(rejectAll.consentMode?.before?.signalsDetected || [])
    ];
    const uniqueSignals = [...new Set(allSignals)];
    
    const consentMode = {
      implemented: uniqueSignals.length > 0,
      signalsDetected: uniqueSignals,
      defaultState: baseline.consentMode?.before || null,
      acceptAllState: acceptAll.consentMode?.after || null,
      rejectAllState: rejectAll.consentMode?.after || null,
      tcfPresent: !!(
        baseline.consentMode?.before?.tcfPresent ||
        acceptAll.consentMode?.before?.tcfPresent ||
        rejectAll.consentMode?.before?.tcfPresent
      ),
      uspPresent: !!(
        baseline.consentMode?.before?.uspPresent ||
        acceptAll.consentMode?.before?.uspPresent ||
        rejectAll.consentMode?.before?.uspPresent
      ),
    };
    
    // Build tracking flows object
    const trackingFlows = {
      preConsent: {
        tracking: preConsent.tracking,
        dataLayerEvents: preConsent.dataLayerEvents,
        actionTaken: preConsent.actionTaken
      },
      baseline: {
        tracking: baseline.tracking,
        dataLayerEvents: baseline.dataLayerEvents,
        actionTaken: baseline.actionTaken
      },
      acceptAll: {
        tracking: acceptAll.tracking,
        dataLayerEvents: acceptAll.dataLayerEvents,
        actionTaken: acceptAll.actionTaken
      },
      rejectAll: {
        tracking: rejectAll.tracking,
        dataLayerEvents: rejectAll.dataLayerEvents,
        actionTaken: rejectAll.actionTaken
      }
    };
    
    // Analyze server-side tracking
    const serverSideAnalysis = analyzeServerSideTracking(cmp, consentMode, trackingFlows, url);
    
    return {
      url,
      status: 'ok',
      errorMessage: null,
      meta: {
        finalUrl: preConsent.finalUrl || baseline.finalUrl || url,
        httpStatus: baseline.httpStatus,
        timestamp: new Date().toISOString(),
        userAgent: 'Chrome/120.0.0.0',
        totalDuration: (preConsent.duration || 0) + baseline.duration + acceptAll.duration + rejectAll.duration,
        geoRedirect: !!(preConsent.geoRedirect || baseline.geoRedirect),
        geoRedirectReason: preConsent.geoRedirectReason || baseline.geoRedirectReason || null,
      },
      // Top-level pre-consent counters — easy for the persister to read.
      preConsent: {
        ga4Count: preConsent.success === false ? null
          : (preConsent.tracking?.preConsentGa4Count ?? 0),
        adsCount: preConsent.success === false ? null
          : (preConsent.tracking?.preConsentAdsCount ?? 0),
        gtmCount: preConsent.success === false ? null
          : (preConsent.tracking?.preConsentGtmCount ?? 0),
        ga4CookielessCount: preConsent.success === false ? null
          : (preConsent.tracking?.preConsentGa4CookielessCount ?? 0),
        adsCookielessCount: preConsent.success === false ? null
          : (preConsent.tracking?.preConsentAdsCookielessCount ?? 0),
        flowFailed: preConsent.success === false,
      },
      // Flat top-level aliases (preferred by run-js-scan persister). No
      // baseline fallback and no fallback to raw ga4EventsCount/adsEventsCount
      // (which would re-include cookieless hits). If the dedicated preConsent
      // flow failed we emit null so downstream (finalAssessment) treats the
      // pre-consent state as UNVERIFIED rather than fabricating a
      // "no violations" result. Counts here are ALWAYS non-cookieless
      // (consented-state) collect hits only; compliant gcs=G100 cookieless
      // pings are exclusively counted in preConsentGa4CookielessCount /
      // preConsentAdsCookielessCount.
      preConsentFlowFailed: preConsent.success === false,
      preConsentGa4Count: preConsent.success === false
        ? null
        : (preConsent.tracking?.preConsentGa4Count ?? 0),
      preConsentAdsCount: preConsent.success === false
        ? null
        : (preConsent.tracking?.preConsentAdsCount ?? 0),
      preConsentGtmCount: preConsent.success === false
        ? null
        : (preConsent.tracking?.preConsentGtmCount ?? 0),
      preConsentGa4CookielessCount: preConsent.success === false
        ? null
        : (preConsent.tracking?.preConsentGa4CookielessCount ?? 0),
      preConsentAdsCookielessCount: preConsent.success === false
        ? null
        : (preConsent.tracking?.preConsentAdsCookielessCount ?? 0),
      waf: {
        blocked: false,
        reason: null
      },
      cmp,
      consentMode,
      tracking: {
        flows: trackingFlows,
        possibleServerSideTracking: serverSideAnalysis.possibleServerSideTracking,
        serverSideHeuristics: serverSideAnalysis.serverSideHeuristics,
        trackingSummary: serverSideAnalysis.trackingSummary || null
      },
      screenshots: {
        preConsent: {
          before: preConsent.screenshots?.before || null,
          after: null
        },
        baseline: {
          before: baseline.screenshots?.before || null,
          after: baseline.screenshots?.after || null
        },
        acceptAll: {
          before: acceptAll.screenshots?.before || null,
          after: acceptAll.screenshots?.after || null
        },
        rejectAll: {
          before: rejectAll.screenshots?.before || null,
          after: rejectAll.screenshots?.after || null
        }
      }
    };
    
  } catch (error) {
    console.error('[JS-SCAN] Fatal error:', error);
    
    // Handle timeout errors specifically
    const isTimeout = error.message?.includes('timeout') || 
                     error.message?.includes('Navigation timeout');
    
    return {
      url,
      status: 'error',
      errorMessage: isTimeout ? 'Navigation timeout exceeded' : (error.message || 'Unknown error'),
      meta: {
        timestamp: new Date().toISOString()
      },
      waf: {
        blocked: false,
        reason: null
      }
    };
    
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// ============================================================================
// Express API server
// ============================================================================

const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check — also reports scanner version so you can VERIFY the deploy:
// curl https://<your-railway-url>/health  → version must be "2.1-fixes-6a"
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', version: '2.1-fixes-6a' });
});

async function handleScan(req, res) {
  try {
    const { url, maxWaitMs = 20000 } = req.body || {};

    if (!url) {
      return res.status(400).json({
        status: 'error',
        errorMessage: 'Missing required field: url',
        meta: { timestamp: new Date().toISOString() }
      });
    }
    try { new URL(url); } catch {
      return res.status(400).json({
        status: 'error',
        errorMessage: 'Invalid URL format',
        meta: { timestamp: new Date().toISOString() }
      });
    }

    console.log(`[JS-SCAN] Starting scan for: ${url}`);
    const result = await runJsScanV2({ url, maxWaitMs });
    console.log(`[JS-SCAN] Completed scan for: ${url} - status: ${result.status}`);

    res.status(result.status === 'ok' ? 200 : 500).json(result);
  } catch (error) {
    console.error('[JS-SCAN] Unexpected error:', error);
    res.status(500).json({
      url: (req.body && req.body.url) || 'unknown',
      status: 'error',
      errorMessage: error.message || 'Unknown error',
      meta: { timestamp: new Date().toISOString() }
    });
  }
}

// Primary route + aliases so this file works regardless of which path your
// Supabase JS_SCAN_SERVICE_URL points at.
app.post('/api/js-scan', handleScan);
app.post('/scan', handleScan);
app.post('/', handleScan);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    errorMessage: 'Endpoint not found',
    meta: { timestamp: new Date().toISOString() }
  });
});

app.listen(PORT, () => {
  console.log(`JS Scanner V2 (2.1-fixes-6a) running on port ${PORT}`);
  console.log(`Health: GET /health | Scan: POST /api/js-scan`);
});
