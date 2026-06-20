const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'consentpilot-js-scanner', timestamp: new Date().toISOString() });
});

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

async function detectCmpAndButtons(page) {
  try {
    // Check main frame first, then iframes
    const frames = page.frames();
    let cmpData = null;

    for (const frame of frames) {
      try {
        const result = await frame.evaluate(() => {
          const html = document.documentElement.innerHTML.toLowerCase();

          const vendors = {
            'OneTrust': ['onetrust', 'ot-sdk-btn'],
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

          const acceptPatterns = ['accept all','accept cookies','agree to all','allow all cookies','allow all','akzeptieren','alle akzeptieren','tout accepter','accepter tout','i agree','i accept'];
          const rejectPatterns = ['reject all','decline all','only necessary','only essential','necessary only','ablehnen','alle ablehnen','refuser tout','continue without accepting','manage preferences'];

          const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));

          let acceptButton = null;
          let rejectButton = null;

          for (const btn of buttons) {
            const text = (btn.innerText || btn.textContent || btn.value || '').toLowerCase().trim();
            const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
            const fullText = `${text} ${ariaLabel}`.trim();
            if (!fullText) continue;

            if (!acceptButton && acceptPatterns.some(p => fullText.includes(p))) {
              acceptButton = { text: text.substring(0, 80) };
            }
            if (!rejectButton && rejectPatterns.some(p => fullText.includes(p))) {
              rejectButton = { text: text.substring(0, 80) };
            }
          }

          return {
            detected: !!detectedVendor,
            vendor: detectedVendor,
            hasAcceptAll: !!acceptButton,
            hasRejectAll: !!rejectButton,
            acceptButtonText: acceptButton?.text || null,
            rejectButtonText: rejectButton?.text || null,
            foundInFrame: true
          };
        });

        // Use first frame that finds a vendor or buttons
        if (result.detected || result.hasAcceptAll || result.hasRejectAll) {
          cmpData = result;
          break;
        }

        // Keep as fallback if main frame
        if (!cmpData) cmpData = result;

      } catch (frameErr) {
        // iframe may be cross-origin, skip it
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

async function clickButtonInAllFrames(page, targetText) {
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
      }, targetText);
      if (clicked) return true;
    } catch (frameErr) {
      continue;
    }
  }
  return false;
}

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
        if (item.ad_storage) ad_storage = item.ad_storage;
        if (item.analytics_storage) analytics_storage = item.analytics_storage;
      }

      const scripts = Array.from(document.querySelectorAll('script'));
      const scriptContent = scripts.map(s => s.textContent || '').join(' ');
      if (scriptContent.includes('gtag') && scriptContent.includes('consent')) {
        if (scriptContent.includes('ad_storage') && !signalsDetected.includes('ad_storage')) { signalsDetected.push('ad_storage'); ad_storage = ad_storage || 'unknown'; }
        if (scriptContent.includes('analytics_storage') && !signalsDetected.includes('analytics_storage')) { signalsDetected.push('analytics_storage'); analytics_storage = analytics_storage || 'unknown'; }
      }

      return { ad_storage, analytics_storage, ad_user_data, ad_personalization, signalsDetected: [...new Set(signalsDetected)] };
    });
    return consentState;
  } catch (e) {
    return { ad_storage: null, analytics_storage: null, ad_user_data: null, ad_personalization: null, signalsDetected: [] };
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

    page.on('request', request => {
      const u = request.url();
      if (u.includes('google-analytics.com/g/collect') || u.includes('googletagmanager.com/gtag/js?id=G-') || u.includes('region1.google-analytics.com/g/collect')) {
        networkSummary.ga4Requests.push({ url: u.substring(0, 150), method: request.method() });
      } else if (u.includes('googleadservices.com/pagead/conversion') || u.includes('googleads.g.doubleclick.net')) {
        networkSummary.adsRequests.push({ url: u.substring(0, 150), method: request.method() });
      } else if (u.includes('googletagmanager.com/gtm.js') || u.includes('GTM-')) {
        networkSummary.gtmRequests.push({ url: u.substring(0, 150), method: request.method() });
      }
    });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const httpStatus = response?.status() || null;
    const finalUrl = page.url();

    const wafStatus = await detectWafBlocking(page, response);
    if (wafStatus.blocked) {
      return { flowName, success: false, duration: Date.now() - startTime, finalUrl, httpStatus, wafBlocked: true, wafReason: wafStatus.reason, error: 'Site blocked by WAF or captcha', timestamp: new Date().toISOString() };
    }

    // Wait for CMP to load
    await page.waitForTimeout(2500);

    const cmpData = await detectCmpAndButtons(page);
    const consentModeBefore = await detectConsentModeState(page);

    let actionTaken = null;

    if (flowName === 'acceptAll' && cmpData.hasAcceptAll && cmpData.acceptButtonText) {
      const clicked = await clickButtonInAllFrames(page, cmpData.acceptButtonText.toLowerCase());
      actionTaken = clicked ? `Clicked accept: ${cmpData.acceptButtonText}` : `Accept button not found: ${cmpData.acceptButtonText}`;
      await page.waitForTimeout(2500);
      await page.waitForNetworkIdle({ timeout: 4000 }).catch(() => {});
    } else if (flowName === 'rejectAll' && cmpData.hasRejectAll && cmpData.rejectButtonText) {
      const clicked = await clickButtonInAllFrames(page, cmpData.rejectButtonText.toLowerCase());
      actionTaken = clicked ? `Clicked reject: ${cmpData.rejectButtonText}` : `Reject button not found: ${cmpData.rejectButtonText}`;
      await page.waitForTimeout(2500);
      await page.waitForNetworkIdle({ timeout: 4000 }).catch(() => {});
    } else if (flowName === 'baseline') {
      actionTaken = 'No interaction (baseline flow)';
    } else {
      actionTaken = `Button not found for ${flowName}`;
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

async function runJsScanV2({ url, maxWaitMs = 15000 }) {
  const TOTAL_SCAN_TIMEOUT = 90000;
  const scanStartTime = Date.now();
  let browser = null;

  try {
    console.log(`[JS-SCAN] Starting scan for: ${url}`);

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-blink-features=AutomationControlled','--window-size=1366,768']
    });

    console.log('[JS-SCAN] Running baseline flow...');
    const baseline = await runFlow(browser, url, 'baseline', maxWaitMs);

    if (baseline.wafBlocked) {
      return { url, status: 'blocked_waf', errorMessage: baseline.wafReason || 'WAF detected', meta: { finalUrl: baseline.finalUrl || url, httpStatus: baseline.httpStatus, timestamp: new Date().toISOString() }, waf: { blocked: true, reason: baseline.wafReason } };
    }

    if (Date.now() - scanStartTime > TOTAL_SCAN_TIMEOUT - 25000) {
      return { url, status: 'partial', errorMessage: 'Scan timeout after baseline', meta: { timestamp: new Date().toISOString() }, cmp: baseline.cmp, tracking: { flows: { baseline: { tracking: baseline.tracking, dataLayerEvents: baseline.dataLayerEvents, actionTaken: baseline.actionTaken } } } };
    }

    console.log('[JS-SCAN] Running acceptAll flow...');
    const acceptAll = await runFlow(browser, url, 'acceptAll', maxWaitMs);

    if (Date.now() - scanStartTime > TOTAL_SCAN_TIMEOUT - 25000) {
      return { url, status: 'partial', errorMessage: 'Scan timeout after acceptAll', meta: { timestamp: new Date().toISOString() }, cmp: baseline.cmp || acceptAll.cmp, tracking: { flows: { baseline: { tracking: baseline.tracking, actionTaken: baseline.actionTaken }, acceptAll: { tracking: acceptAll.tracking, actionTaken: acceptAll.actionTaken } } } };
    }

    console.log('[JS-SCAN] Running rejectAll flow...');
    const rejectAll = await runFlow(browser, url, 'rejectAll', maxWaitMs);

    const cmp = baseline.cmp || acceptAll.cmp || rejectAll.cmp;
    const allSignals = [...(baseline.consentMode?.before?.signalsDetected || []), ...(acceptAll.consentMode?.before?.signalsDetected || []), ...(rejectAll.consentMode?.before?.signalsDetected || [])];
    const uniqueSignals = [...new Set(allSignals)];

    const totalDuration = Date.now() - scanStartTime;
    console.log(`[JS-SCAN] Completed in ${totalDuration}ms`);

    return {
      url, status: 'ok', errorMessage: null,
      meta: { finalUrl: baseline.finalUrl || url, httpStatus: baseline.httpStatus, timestamp: new Date().toISOString(), totalDuration },
      waf: { blocked: false, reason: null },
      cmp,
      consentMode: {
        implemented: uniqueSignals.length > 0,
        signalsDetected: uniqueSignals,
        defaultState: baseline.consentMode?.before || null,
        acceptAllState: acceptAll.consentMode?.after || null,
        rejectAllState: rejectAll.consentMode?.after || null
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
    const isTimeout = error.message?.includes('timeout');
    return { url, status: 'error', errorMessage: isTimeout ? 'Navigation timeout' : (error.message || 'Unknown error'), meta: { timestamp: new Date().toISOString() }, waf: { blocked: false, reason: null } };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

app.post('/api/js-scan', async (req, res) => {
  try {
    const { url, maxWaitMs = 15000 } = req.body;
    if (!url) return res.status(400).json({ status: 'error', errorMessage: 'Missing url' });
    try { new URL(url); } catch { return res.status(400).json({ status: 'error', errorMessage: 'Invalid URL format' }); }
    const result = await runJsScanV2({ url, maxWaitMs });
    res.status(result.status === 'ok' ? 200 : 500).json(result);
  } catch (error) {
    res.status(500).json({ status: 'error', errorMessage: error.message });
  }
});

app.use((req, res) => res.status(404).json({ status: 'error', errorMessage: 'Endpoint not found' }));

app.listen(PORT, () => {
  console.log(`JS scan service listening on port ${PORT}`);
});
