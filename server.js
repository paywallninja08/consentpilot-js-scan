const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'consentpilot-js-scanner', version: '3.0', timestamp: new Date().toISOString() });
});

// ─── FIX 1: EXHAUSTIVE GA4 MATCHERS ────────────────────────────────────────
function isGa4Request(url) {
  return (
    url.includes('google-analytics.com/g/collect') ||
    url.includes('analytics.google.com/g/collect') ||        // ← Gymshark uses THIS
    url.includes('region1.google-analytics.com/g/collect') ||
    url.includes('region1.analytics.google.com/g/collect') ||
    url.includes('stats.g.doubleclick.net/g/collect') ||
    url.includes('googletagmanager.com/gtag/js') ||           // GTM-loaded GA4
    url.includes('googletagmanager.com/gtag/destination') ||
    // signature fallback — tid=G- in collect calls
    (url.includes('/g/collect') && url.includes('tid=G-'))
  );
}

// ─── FIX 2: EXHAUSTIVE ADS MATCHERS ────────────────────────────────────────
function isAdsRequest(url) {
  return (
    url.includes('googleadservices.com/pagead/conversion') ||
    url.includes('googleadservices.com/pagead/1p-conversion') ||
    url.includes('googleadservices.com/pagead/1p-user-list') ||
    url.includes('googleads.g.doubleclick.net') ||
    url.includes('cm.g.doubleclick.net') ||
    url.includes('ad.doubleclick.net') ||
    url.includes('stats.g.doubleclick.net/dc/')
  );
}

function isGtmRequest(url) {
  return (
    url.includes('googletagmanager.com/gtm.js') ||
    url.includes('googletagmanager.com/gtag/js') ||
    (url.includes('GTM-') && url.includes('googletagmanager.com'))
  );
}

// ─── FIX 5: GEO-REDIRECT DETECTION ─────────────────────────────────────────
function detectGeoRedirect(inputUrl, finalUrl) {
  try {
    const input = new URL(inputUrl);
    const final = new URL(finalUrl);

    if (input.hostname === final.hostname) return { geoRedirect: false };

    const checkoutSubdomains = ['checkout', 'cart', 'account', 'pay', 'billing', 'store', 'shop', 'us', 'de', 'fr', 'eu', 'au', 'ca', 'jp', 'uk'];
    const finalSub = final.hostname.split('.')[0].toLowerCase();
    const inputSub = input.hostname.split('.')[0].toLowerCase();

    const inputTld = input.hostname.split('.').slice(-2).join('.');
    const finalTld = final.hostname.split('.').slice(-2).join('.');
    const tldChanged = inputTld !== finalTld;

    const landedOnCheckout = checkoutSubdomains.some(s => finalSub === s || final.hostname.includes(`${s}.`));
    const subdomainChanged = finalSub !== inputSub && finalSub !== 'www';

    if (tldChanged || landedOnCheckout || subdomainChanged) {
      return {
        geoRedirect: true,
        geoRedirectReason: landedOnCheckout
          ? `Redirected to ${final.hostname} (checkout/region subdomain — results may not reflect original page)`
          : tldChanged
            ? `TLD changed from ${inputTld} to ${finalTld} (geo-redirect)`
            : `Subdomain changed from ${input.hostname} to ${final.hostname}`,
        finalUrl: finalUrl
      };
    }
    return { geoRedirect: false };
  } catch {
    return { geoRedirect: false };
  }
}

// ─── WAIT FOR CMP BANNER TO RENDER ─────────────────────────────────────────
async function waitForCmpBanner(page, timeoutMs = 5000) {
  const selectors = [
    '#onetrust-banner-sdk',
    '#onetrust-consent-sdk',
    '#CybotCookiebotDialog',
    '#usercentrics-root',
    '#didomi-host',
    '.ot-sdk-container',
    '[id^="sp_message_container"]',
  ];
  try {
    await page.waitForFunction(
      (sels) => sels.some((s) => document.querySelector(s)),
      { timeout: timeoutMs },
      selectors,
    );
    return true;
  } catch {
    return false;
  }
}

async function detectWafBlocking(page, response) {
  try {
    const httpStatus = response?.status() || 200;
    if ([401, 403, 503].includes(httpStatus)) {
      const pageData = await page.evaluate(() => {
        const title = document.title.toLowerCase();
        const bodyText = document.body?.innerText?.toLowerCase() || '';
        const html = document.documentElement.innerHTML.toLowerCase();
        const wafPatterns = ['access denied','forbidden','request blocked','web application firewall','checking your browser','are you a robot','captcha','cloudflare','incapsula','akamai','attention required','bot protection','security check'];
        const hasWafPattern = wafPatterns.some(p => title.includes(p) || bodyText.includes(p) || html.includes(p));
        return { hasWafPattern, bodyLength: bodyText.length };
      });
      if (pageData.hasWafPattern || pageData.bodyLength < 500) {
        return { blocked: true, reason: `HTTP ${httpStatus} with WAF/bot detection patterns` };
      }
    }
    const hasCaptcha = await page.evaluate(() => {
      const selectors = ['[class*="captcha"]','[id*="captcha"]','iframe[src*="recaptcha"]','iframe[src*="hcaptcha"]','.g-recaptcha','#cf-challenge-running'];
      return selectors.some(s => document.querySelector(s) !== null);
    });
    if (hasCaptcha) return { blocked: true, reason: 'Captcha challenge detected' };
    return { blocked: false, reason: null };
  } catch (e) {
    return { blocked: false, reason: null };
  }
}

// ─── FIX 4: REJECT-FIRST BUTTON MATCHING ───────────────────────────────────
async function detectCmpAndButtons(page) {
  try {
    const frames = page.frames();
    let cmpData = null;

    for (const frame of frames) {
      try {
        const result = await frame.evaluate(() => {
          const html = document.documentElement.innerHTML.toLowerCase();

          const vendors = {
            'OneTrust': ['onetrust', 'ot-sdk-btn', 'optanon'],
            'Cookiebot': ['cookiebot', 'cookieconsent'],
            'Usercentrics': ['usercentrics', 'uc-'],
            'Didomi': ['didomi', 'didomi-consent'],
            'Quantcast': ['quantcast', 'qc-cmp'],
            'TrustArc': ['trustarc', 'truste'],
            'Osano': ['osano'],
            'Termly': ['termly']
          };

          let detectedVendor = null;
          for (const [vendor, patterns] of Object.entries(vendors)) {
            if (patterns.some(p => html.includes(p))) {
              detectedVendor = vendor;
              break;
            }
          }

          const hasCmpMarkers = html.includes('cookie') && (html.includes('consent') || html.includes('banner') || html.includes('accept'));
          if (!detectedVendor && hasCmpMarkers) detectedVendor = 'Custom or unknown';

          // REJECT patterns checked FIRST — order is critical
          // Includes "accept only essential" style buttons which are REJECT actions
          const rejectPatterns = [
            'reject all', 'reject cookies', 'decline all', 'decline cookies',
            'only necessary', 'only essential', 'necessary only', 'essential only',
            'accept only essential', 'accept only necessary',      // ← Gymshark
            'accept essential only', 'accept necessary only',
            'necessary cookies only', 'essential cookies only',
            'continue without accepting', 'continue without agreeing',
            'refuse all', 'refuse cookies',
            'ablehnen', 'alle ablehnen', 'nur notwendige',
            'refuser tout', 'continuer sans accepter',
            'manage preferences', 'cookie settings'
          ];

          const acceptPatterns = [
            'accept all cookies', 'accept all', 'allow all cookies', 'allow all',
            'agree to all', 'i agree', 'i accept', 'accept cookies',
            'akzeptieren', 'alle akzeptieren',
            'tout accepter', 'accepter tout'
          ];

          const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));

          let acceptButton = null;
          let rejectButton = null;

          for (const btn of buttons) {
            const text = (btn.innerText || btn.textContent || btn.value || '').toLowerCase().trim();
            const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
            const id = (btn.id || '').toLowerCase();
            const fullText = `${text} ${ariaLabel} ${id}`.trim();
            if (!fullText) continue;

            // Check REJECT first
            if (!rejectButton && rejectPatterns.some(p => fullText.includes(p))) {
              rejectButton = { text: text.substring(0, 80) };
            }
            // Then check accept — but only if it doesn't match a reject pattern
            if (!acceptButton && acceptPatterns.some(p => fullText.includes(p))) {
              const isActuallyReject = rejectPatterns.some(p => fullText.includes(p));
              if (!isActuallyReject) {
                acceptButton = { text: text.substring(0, 80) };
              }
            }
          }

          // Also try OneTrust specific IDs as fallback
          if (!acceptButton) {
            const otAccept = document.querySelector('#onetrust-accept-btn-handler');
            if (otAccept) acceptButton = { text: (otAccept.innerText || 'Accept All Cookies').substring(0, 80) };
          }
          if (!rejectButton) {
            const otReject = document.querySelector('#onetrust-reject-all-handler');
            if (otReject) rejectButton = { text: (otReject.innerText || 'Reject All').substring(0, 80) };
          }

          return {
            detected: !!detectedVendor,
            vendor: detectedVendor,
            hasAcceptAll: !!acceptButton,
            hasRejectAll: !!rejectButton,
            acceptButtonText: acceptButton?.text || null,
            rejectButtonText: rejectButton?.text || null,
          };
        });

        if (result.detected || result.hasAcceptAll || result.hasRejectAll) {
          cmpData = result;
          break;
        }
        if (!cmpData) cmpData = result;

      } catch (frameErr) {
        continue;
      }
    }

    return cmpData || {
      detected: false, vendor: null,
      hasAcceptAll: false, hasRejectAll: false,
      acceptButtonText: null, rejectButtonText: null
    };

  } catch (e) {
    console.error('[CMP Detection Error]:', e.message);
    return { detected: false, vendor: null, hasAcceptAll: false, hasRejectAll: false, acceptButtonText: null, rejectButtonText: null };
  }
}

async function clickButtonInAllFrames(page, action /* 'accept' | 'reject' | text string */) {
  // Determine intent from action string
  const rejectKeywords = ['essential', 'necessary', 'reject', 'decline', 'refuse', 'without'];
  const isReject = rejectKeywords.some(k => action.includes(k));

  // Direct-by-ID for known CMPs — most reliable, locale-independent
  const directIds = isReject
    ? [
        '#onetrust-reject-all-handler',
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
        '#didomi-notice-disagree-button',
        '.ot-pc-refuse-all-handler',
      ]
    : [
        '#onetrust-accept-btn-handler',
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        '#didomi-notice-agree-button',
        '.ot-pc-accept-all-handler',
      ];

  for (const sel of directIds) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
        await el.click({ delay: 50 });
        console.log(`[JS-SCAN] Clicked ${isReject ? 'reject' : 'accept'} via direct ID: ${sel}`);
        return true;
      }
    } catch (err) {
      console.log(`[JS-SCAN] Direct-ID click failed for ${sel}: ${err.message}`);
    }
  }

  // Fallback: text matching across all frames
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const clicked = await frame.evaluate((text) => {
        const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
        const btn = buttons.find(b => {
          const t = (b.innerText || b.textContent || b.value || '').toLowerCase().trim();
          return t.includes(text) || text.includes(t.substring(0, 30));
        });
        if (btn) { btn.click(); return true; }
        return false;
      }, action);
      if (clicked) return true;
    } catch (frameErr) {
      continue;
    }
  }
  return false;
}

// ─── FIX 8: ENHANCED CONSENT MODE DETECTION ────────────────────────────────
async function detectConsentModeState(page) {
  try {
    const consentState = await page.evaluate(() => {
      const dataLayer = window.dataLayer || [];
      let ad_storage = null, analytics_storage = null, ad_user_data = null, ad_personalization = null;
      const signalsDetected = [];

      for (const item of dataLayer) {
        if (!item || typeof item !== 'object') continue;
        if (item[0] === 'consent' && item[2]) {
          const c = item[2];
          if (c.ad_storage) { ad_storage = c.ad_storage; signalsDetected.push('ad_storage'); }
          if (c.analytics_storage) { analytics_storage = c.analytics_storage; signalsDetected.push('analytics_storage'); }
          if (c.ad_user_data) { ad_user_data = c.ad_user_data; signalsDetected.push('ad_user_data'); }
          if (c.ad_personalization) { ad_personalization = c.ad_personalization; signalsDetected.push('ad_personalization'); }
        }
        if (item.ad_storage && !ad_storage) ad_storage = item.ad_storage;
        if (item.analytics_storage && !analytics_storage) analytics_storage = item.analytics_storage;
      }

      // Check window.google_tag_data (GTM internal consent store)
      try {
        const gtd = window.google_tag_data;
        if (gtd && gtd.ics && gtd.ics.entries) {
          const entries = gtd.ics.entries;
          if (entries.ad_storage && !ad_storage) { ad_storage = entries.ad_storage.update || null; signalsDetected.push('ad_storage'); }
          if (entries.analytics_storage && !analytics_storage) { analytics_storage = entries.analytics_storage.update || null; signalsDetected.push('analytics_storage'); }
        }
      } catch (_) {}

      // Check gtag queue
      try {
        if (typeof window.gtag === 'function' && window.gtag.q) {
          for (const call of window.gtag.q || []) {
            if (call[0] === 'consent' && call[2]) {
              const c = call[2];
              if (c.ad_storage && !ad_storage) { ad_storage = c.ad_storage; signalsDetected.push('ad_storage'); }
              if (c.analytics_storage && !analytics_storage) { analytics_storage = c.analytics_storage; signalsDetected.push('analytics_storage'); }
            }
          }
        }
      } catch (_) {}

      const scripts = Array.from(document.querySelectorAll('script'));
      const scriptContent = scripts.map(s => s.textContent || '').join(' ');
      if (scriptContent.includes('gtag') && scriptContent.includes('consent')) {
        if (scriptContent.includes('ad_storage') && !signalsDetected.includes('ad_storage')) { signalsDetected.push('ad_storage'); ad_storage = ad_storage || 'unknown'; }
        if (scriptContent.includes('analytics_storage') && !signalsDetected.includes('analytics_storage')) { signalsDetected.push('analytics_storage'); analytics_storage = analytics_storage || 'unknown'; }
      }

      return {
        ad_storage, analytics_storage, ad_user_data, ad_personalization,
        signalsDetected: [...new Set(signalsDetected)],
        tcfPresent: typeof window.__tcfapi === 'function',
        uspPresent: typeof window.__uspapi === 'function',
        hasGtag: typeof window.gtag === 'function',
        hasDataLayer: Array.isArray(window.dataLayer)
      };
    });
    return consentState;
  } catch (e) {
    return { ad_storage: null, analytics_storage: null, ad_user_data: null, ad_personalization: null, signalsDetected: [], tcfPresent: false, uspPresent: false };
  }
}

async function captureDataLayerEvents(page) {
  try {
    return await page.evaluate(() => {
      return (window.dataLayer || []).slice(0, 20).map(item => {
        if (!item || typeof item !== 'object') return null;
        return { event: item.event || item[0] || null, consent_related: item.consent || item.ad_storage || null };
      }).filter(Boolean);
    });
  } catch (e) { return []; }
}

// ─── FIX 3: PRE-CONSENT FLOW ────────────────────────────────────────────────
async function runPreConsentFlow(browser, url, maxWaitMs) {
  const startTime = Date.now();
  let context = null, page = null;

  try {
    context = await browser.createIncognitoBrowserContext();
    page = await context.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });

    const preConsentHits = { ga4: [], ads: [], gtm: [] };

    // Capture ALL network hits from page load — before any interaction
    page.on('request', request => {
      const u = request.url();
      if (isGa4Request(u)) preConsentHits.ga4.push(u.substring(0, 150));
      else if (isAdsRequest(u)) preConsentHits.ads.push(u.substring(0, 150));
      else if (isGtmRequest(u)) preConsentHits.gtm.push(u.substring(0, 150));
    });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const finalUrl = page.url();
    const httpStatus = response?.status() || null;

    // Wait for CMP to appear — poll up to 4s
    let bannerDetected = false;
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(500);
      const hasBanner = await page.evaluate(() => {
        return !!(
          document.querySelector('#onetrust-banner-sdk') ||
          document.querySelector('#onetrust-consent-sdk') ||
          document.querySelector('[class*="cookie-banner"]') ||
          document.querySelector('[class*="consent-banner"]') ||
          document.querySelector('[id*="cookie-consent"]') ||
          (document.body && document.body.innerHTML.toLowerCase().includes('accept all cookies'))
        );
      }).catch(() => false);
      if (hasBanner) { bannerDetected = true; break; }
    }

    // Record hits captured BEFORE any banner interaction
    const preConsentGa4Count = preConsentHits.ga4.length;
    const preConsentAdsCount = preConsentHits.ads.length;
    const preConsentGtmCount = preConsentHits.gtm.length;

    // Capture banner screenshot while banner still visible — no interaction yet
    let bannerScreenshot = null;
    try {
      const buf = await page.screenshot({ encoding: 'base64', fullPage: false });
      bannerScreenshot = `data:image/png;base64,${buf}`;
      console.log('[JS-SCAN] Banner screenshot captured');
    } catch (e) {
      console.log('[JS-SCAN] Screenshot failed:', e.message);
    }

    // Geo-redirect detection
    const geoInfo = detectGeoRedirect(url, finalUrl);

    return {
      flowName: 'preConsent',
      success: true,
      duration: Date.now() - startTime,
      finalUrl,
      httpStatus,
      bannerDetected,
      preConsentGa4Count,
      preConsentAdsCount,
      preConsentGtmCount,
      preConsentGa4Urls: preConsentHits.ga4.slice(0, 10),
      preConsentAdsUrls: preConsentHits.ads.slice(0, 10),
      bannerScreenshot,
      ...geoInfo,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    return {
      flowName: 'preConsent',
      success: false,
      duration: Date.now() - startTime,
      preConsentGa4Count: 0,
      preConsentAdsCount: 0,
      preConsentGtmCount: 0,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

async function runFlow(browser, url, flowName, maxWaitMs) {
  const startTime = Date.now();
  let context = null, page = null;

  try {
    context = await browser.createIncognitoBrowserContext();
    page = await context.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });

    const networkSummary = { ga4Requests: [], adsRequests: [], gtmRequests: [], otherTracking: [] };

    // FIX 1+2: Use exhaustive matchers
    page.on('request', request => {
      const u = request.url();
      if (isGa4Request(u)) {
        networkSummary.ga4Requests.push({ url: u.substring(0, 150), method: request.method() });
      } else if (isAdsRequest(u)) {
        networkSummary.adsRequests.push({ url: u.substring(0, 150), method: request.method() });
      } else if (isGtmRequest(u)) {
        networkSummary.gtmRequests.push({ url: u.substring(0, 150), method: request.method() });
      }
    });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const httpStatus = response?.status() || null;
    const finalUrl = page.url();

    const wafStatus = await detectWafBlocking(page, response);
    if (wafStatus.blocked) {
      return { flowName, success: false, duration: Date.now() - startTime, finalUrl, httpStatus, wafBlocked: true, wafReason: wafStatus.reason, error: 'WAF blocked', timestamp: new Date().toISOString() };
    }

    // Wait for CMP banner to render — OneTrust injects 3-5s after domcontentloaded
    if (flowName === 'acceptAll' || flowName === 'rejectAll') {
      const bannerReady = await waitForCmpBanner(page, 6000);
      console.log(`[JS-SCAN] [${flowName}] CMP banner ready: ${bannerReady}`);
      if (!bannerReady) await page.waitForTimeout(3500); // fallback wait
    } else {
      await page.waitForTimeout(3500);
    }

    const cmpData = await detectCmpAndButtons(page);
    const consentModeBefore = await detectConsentModeState(page);

    let actionTaken = null;

    if (flowName === 'acceptAll') {
      // Pass 'accept' intent — clickButtonInAllFrames tries IDs first
      const clicked = await clickButtonInAllFrames(page, cmpData.acceptButtonText?.toLowerCase() || 'accept');
      actionTaken = clicked ? `Clicked accept: ${cmpData.acceptButtonText || 'via ID'}` : `Accept button not found`;
      await page.waitForTimeout(2500);
      await page.waitForNetworkIdle({ timeout: 4000 }).catch(() => {});
    } else if (flowName === 'rejectAll') {
      // Pass 'reject' intent — clickButtonInAllFrames tries IDs first
      const clicked = await clickButtonInAllFrames(page, cmpData.rejectButtonText?.toLowerCase() || 'reject essential');
      actionTaken = clicked ? `Clicked reject: ${cmpData.rejectButtonText || 'via ID'}` : `Reject button not found`;
      await page.waitForTimeout(2500);
      await page.waitForNetworkIdle({ timeout: 4000 }).catch(() => {});
    } else if (flowName === 'baseline') {
      actionTaken = 'No interaction (baseline flow)';
    } else {
      actionTaken = `Unknown flow: ${flowName}`;
    }

    const consentModeAfter = await detectConsentModeState(page);
    const dataLayerEvents = await captureDataLayerEvents(page);

    return {
      flowName, success: true, duration: Date.now() - startTime, finalUrl, httpStatus, wafBlocked: false, actionTaken, cmp: cmpData,
      tracking: {
        ga4Detected: networkSummary.ga4Requests.length > 0,
        ga4EventsCount: networkSummary.ga4Requests.length,
        adsDetected: networkSummary.adsRequests.length > 0,
        adsEventsCount: networkSummary.adsRequests.length,
        gtmDetected: networkSummary.gtmRequests.length > 0,
        gtmEventsCount: networkSummary.gtmRequests.length,
        networkSummary: {
          ga4Requests: networkSummary.ga4Requests.slice(0, 10),
          adsRequests: networkSummary.adsRequests.slice(0, 10),
          gtmRequests: networkSummary.gtmRequests.slice(0, 10),
          otherTracking: networkSummary.otherTracking.slice(0, 5)
        }
      },
      consentMode: { before: consentModeBefore, after: consentModeAfter },
      dataLayerEvents: dataLayerEvents.slice(0, 15),
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    return { flowName, success: false, duration: Date.now() - startTime, error: error.message, timestamp: new Date().toISOString() };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

// ─── DEBUG ENDPOINT ─────────────────────────────────────────────────────────
async function runDebugScan(url) {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-blink-features=AutomationControlled']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const report = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"]')).map(b => ({
        tag: b.tagName.toLowerCase(),
        id: b.id || '',
        text: (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 120),
        ariaLabel: b.getAttribute('aria-label') || ''
      }));

      return {
        title: document.title,
        url: location.href,
        buttons,
        oneTrustLandmarks: {
          sdk: !!document.querySelector('#onetrust-consent-sdk'),
          bannerSdk: !!document.querySelector('#onetrust-banner-sdk'),
          acceptBtn: !!document.querySelector('#onetrust-accept-btn-handler'),
          rejectBtn: !!document.querySelector('#onetrust-reject-all-handler'),
        },
        globals: {
          hasOneTrust: typeof window.OneTrust !== 'undefined',
          hasOptanonWrapper: typeof window.OptanonWrapper !== 'undefined',
          hasTcfApi: typeof window.__tcfapi === 'function',
          hasGtag: typeof window.gtag === 'function',
          hasDataLayer: Array.isArray(window.dataLayer),
          dataLayerLength: Array.isArray(window.dataLayer) ? window.dataLayer.length : 0
        }
      };
    });

    return { status: 'ok', ...report };
  } catch (e) {
    return { status: 'error', errorMessage: e.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

app.get('/debug-scan', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ status: 'error', errorMessage: 'Missing url' });
  const result = await runDebugScan(url);
  res.json(result);
});

app.post('/debug-scan', async (req, res) => {
  const url = req.body.url;
  if (!url) return res.status(400).json({ status: 'error', errorMessage: 'Missing url' });
  const result = await runDebugScan(url);
  res.json(result);
});

// ─── MAIN SCAN ORCHESTRATOR ─────────────────────────────────────────────────
async function runJsScanV2({ url, maxWaitMs = 15000 }) {
  const TOTAL_SCAN_TIMEOUT = 100000;
  const scanStartTime = Date.now();
  let browser = null;

  try {
    console.log(`[JS-SCAN] Starting scan for: ${url}`);

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-blink-features=AutomationControlled','--window-size=1366,768']
    });

    // FIX 3: Pre-consent flow runs first — captures tracking before banner interaction
    console.log('[JS-SCAN] Running preConsent flow...');
    const preConsent = await runPreConsentFlow(browser, url, maxWaitMs);
    console.log(`[JS-SCAN] preConsent: GA4=${preConsent.preConsentGa4Count} Ads=${preConsent.preConsentAdsCount} bannerDetected=${preConsent.bannerDetected}`);

    if (Date.now() - scanStartTime > TOTAL_SCAN_TIMEOUT - 30000) {
      return buildPartialResult(url, preConsent, null, null, null);
    }

    console.log('[JS-SCAN] Running baseline flow...');
    const baseline = await runFlow(browser, url, 'baseline', maxWaitMs);

    if (baseline.wafBlocked) {
      return { url, status: 'blocked_waf', errorMessage: baseline.wafReason || 'WAF detected', meta: { finalUrl: baseline.finalUrl || url, httpStatus: baseline.httpStatus, timestamp: new Date().toISOString() }, waf: { blocked: true, reason: baseline.wafReason } };
    }

    if (Date.now() - scanStartTime > TOTAL_SCAN_TIMEOUT - 25000) {
      return buildPartialResult(url, preConsent, baseline, null, null);
    }

    console.log('[JS-SCAN] Running acceptAll flow...');
    const acceptAll = await runFlow(browser, url, 'acceptAll', maxWaitMs);

    if (Date.now() - scanStartTime > TOTAL_SCAN_TIMEOUT - 25000) {
      return buildPartialResult(url, preConsent, baseline, acceptAll, null);
    }

    console.log('[JS-SCAN] Running rejectAll flow...');
    const rejectAll = await runFlow(browser, url, 'rejectAll', maxWaitMs);

    const cmp = baseline.cmp || acceptAll.cmp || rejectAll.cmp;
    const allSignals = [
      ...(baseline.consentMode?.before?.signalsDetected || []),
      ...(acceptAll.consentMode?.before?.signalsDetected || []),
      ...(rejectAll.consentMode?.before?.signalsDetected || [])
    ];

    const totalDuration = Date.now() - scanStartTime;
    console.log(`[JS-SCAN] Completed in ${totalDuration}ms`);

    return {
      url, status: 'ok', errorMessage: null,
      meta: {
        finalUrl: preConsent.finalUrl || baseline.finalUrl || url,
        httpStatus: baseline.httpStatus,
        timestamp: new Date().toISOString(),
        totalDuration
      },
      waf: { blocked: false, reason: null },
      // FIX 3: Pre-consent counts surfaced top-level for risk engine
      preConsentGa4Count: preConsent.preConsentGa4Count || 0,
      preConsentAdsCount: preConsent.preConsentAdsCount || 0,
      preConsentGtmCount: preConsent.preConsentGtmCount || 0,
      preConsentGa4Urls: preConsent.preConsentGa4Urls || [],
      bannerDetected: preConsent.bannerDetected || false,
      bannerScreenshot: preConsent.bannerScreenshot || null,
      // FIX 5: Geo-redirect surfaced top-level
      geoRedirect: preConsent.geoRedirect || false,
      geoRedirectReason: preConsent.geoRedirectReason || null,
      cmp,
      consentMode: {
        implemented: allSignals.length > 0,
        signalsDetected: [...new Set(allSignals)],
        defaultState: baseline.consentMode?.before || null,
        acceptAllState: acceptAll.consentMode?.after || null,
        rejectAllState: rejectAll.consentMode?.after || null,
        tcfPresent: baseline.consentMode?.before?.tcfPresent || false,
        uspPresent: baseline.consentMode?.before?.uspPresent || false
      },
      tracking: {
        flows: {
          baseline: { tracking: baseline.tracking, dataLayerEvents: baseline.dataLayerEvents, actionTaken: baseline.actionTaken },
          acceptAll: { tracking: acceptAll.tracking, dataLayerEvents: acceptAll.dataLayerEvents, actionTaken: acceptAll.actionTaken },
          rejectAll: { tracking: rejectAll.tracking, dataLayerEvents: rejectAll.dataLayerEvents, actionTaken: rejectAll.actionTaken }
        }
      }
    };

  } catch (error) {
    console.error('[JS-SCAN] Fatal error:', error);
    return { url, status: 'error', errorMessage: error.message || 'Unknown error', meta: { timestamp: new Date().toISOString() }, waf: { blocked: false, reason: null } };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function buildPartialResult(url, preConsent, baseline, acceptAll, rejectAll) {
  return {
    url, status: 'partial', errorMessage: 'Scan timeout — partial results',
    meta: { timestamp: new Date().toISOString() },
    preConsentGa4Count: preConsent?.preConsentGa4Count || 0,
    preConsentAdsCount: preConsent?.preConsentAdsCount || 0,
    preConsentGtmCount: preConsent?.preConsentGtmCount || 0,
    geoRedirect: preConsent?.geoRedirect || false,
    geoRedirectReason: preConsent?.geoRedirectReason || null,
    cmp: baseline?.cmp || acceptAll?.cmp || null,
    tracking: {
      flows: {
        ...(baseline ? { baseline: { tracking: baseline.tracking, actionTaken: baseline.actionTaken } } : {}),
        ...(acceptAll ? { acceptAll: { tracking: acceptAll.tracking, actionTaken: acceptAll.actionTaken } } : {}),
        ...(rejectAll ? { rejectAll: { tracking: rejectAll.tracking, actionTaken: rejectAll.actionTaken } } : {})
      }
    }
  };
}

app.post('/api/js-scan', async (req, res) => {
  try {
    const { url, maxWaitMs = 15000 } = req.body;
    if (!url) return res.status(400).json({ status: 'error', errorMessage: 'Missing url' });
    try { new URL(url); } catch { return res.status(400).json({ status: 'error', errorMessage: 'Invalid URL format' }); }
    const result = await runJsScanV2({ url, maxWaitMs });
    res.status(result.status === 'ok' || result.status === 'partial' ? 200 : 500).json(result);
  } catch (error) {
    res.status(500).json({ status: 'error', errorMessage: error.message });
  }
});

app.use((req, res) => res.status(404).json({ status: 'error', errorMessage: 'Endpoint not found' }));

app.listen(PORT, () => {
  console.log(`JS scan service v3.0 listening on port ${PORT}`);
});
