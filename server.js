import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.JS_SCAN_API_KEY || "change-me";

// very naive button text list, you can expand later
const ACCEPT_LABELS = [
  "Accept all",
  "Accept All",
  "I agree",
  "Allow all",
  "Agree"
];

const REJECT_LABELS = [
  "Reject all",
  "Reject All",
  "Decline",
  "Only necessary",
  "Deny"
];

// helper: find button by text
async function clickButtonByLabels(page, labels) {
  for (const label of labels) {
    const locator = page.getByRole("button", { name: label }).first();
    if (await locator.count()) {
      await locator.click().catch(() => {});
      return true;
    }
    // fallback: text selector
    const textLocator = page.locator(`text=${label}`).first();
    if (await textLocator.count()) {
      await textLocator.click().catch(() => {});
      return true;
    }
  }
  return false;
}

// helper: run one flow (accept or reject)
async function runFlow(browser, url, clickMode) {
  const context = await browser.newContext();
  const page = await context.newPage();

  const ga4Events = [];
  const adsEvents = [];
  const gtmContainers = [];

  // hook network
  page.on("request", request => {
    const u = request.url();
    if (u.includes("https://www.google-analytics.com")) {
      ga4Events.push({ url: u, method: request.method() });
    }
    if (u.includes("https://www.googletagmanager.com")) {
      gtmContainers.push({ url: u });
    }
    if (
      u.includes("https://www.googleadservices.com") ||
      u.includes("https://googleads.g.doubleclick.net")
    ) {
      adsEvents.push({ url: u, method: request.method() });
    }
  });

  // go to page
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});

  // give any CMP a bit of time to render
  await page.waitForTimeout(3000);

  if (clickMode === "reject") {
    await clickButtonByLabels(page, REJECT_LABELS);
  } else if (clickMode === "accept") {
    await clickButtonByLabels(page, ACCEPT_LABELS);
  }

  // wait some more to let tags fire after click
  await page.waitForTimeout(5000);

  // very naive consent mode detection: read cookies
  let consentMode = null;
  try {
    const cookies = await context.cookies();
    const gcsCookie = cookies.find(c => c.name === "gcs" || c.name === "_gcs");
    const gState = cookies.find(c => c.name === "G_STATE");
    consentMode = {
      gcs: gcsCookie ? gcsCookie.value : null,
      g_state: gState ? gState.value : null
    };
  } catch {
    consentMode = null;
  }

  await context.close();

  return {
    ga4Events,
    adsEvents,
    gtmContainers,
    consentMode
  };
}

app.post("/js-scan", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token || token !== API_KEY) {
      return res.status(401).json({ status: "error", errorMessage: "Unauthorized" });
    }

    const { url, mode = "accept_and_reject" } = req.body || {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ status: "error", errorMessage: "Missing url" });
    }

    const start = Date.now();
    const browser = await chromium.launch({
      headless: true
    });

    let acceptAllResult = null;
    let rejectAllResult = null;

    if (mode === "accept_and_reject" || mode === "reject_only") {
      rejectAllResult = await runFlow(browser, url, "reject");
    }

    if (mode === "accept_and_reject" || mode === "accept_only") {
      acceptAllResult = await runFlow(browser, url, "accept");
    }

    await browser.close();
    const durationMs = Date.now() - start;

    // try to guess CMP vendor in a naive way
    let cmpVendor = null;
    // if any GA4/Ads requests include known CMP domains, upgrade this later
    // for now just set "Custom" or null
    cmpVendor = "Custom or unknown";

    // count total network logs
    const rawNetworkLogCount =
      (acceptAllResult?.ga4Events?.length || 0) +
      (acceptAllResult?.adsEvents?.length || 0) +
      (rejectAllResult?.ga4Events?.length || 0) +
      (rejectAllResult?.adsEvents?.length || 0);

    // build summaries
    function summarize(flowName, flow) {
      if (!flow) return null;
      const ga4Count = flow.ga4Events.length;
      const adsCount = flow.adsEvents.length;
      const cm = flow.consentMode || {};
      return `Flow ${flowName}: GA4=${ga4Count}, Ads=${adsCount}, consent cookies=${JSON.stringify(
        cm
      )}`;
    }

    const consentFlows = {
      acceptAll: acceptAllResult,
      rejectAll: rejectAllResult
    };

    const responsePayload = {
      status: "ok",
      url,
      cmpVendor,
      consentFlows,
      rawNetworkLogCount,
      durationMs,
      errorMessage: null
    };

    res.json(responsePayload);
  } catch (err) {
    console.error("JS scan error", err);
    res.status(500).json({
      status: "error",
      errorMessage: err?.message || "Unknown JS scan error"
    });
  }
});

app.get("/", (req, res) => {
  res.send("ConsentPilot JS Scan service is running");
});

app.listen(PORT, () => {
  console.log(`JS scan service listening on port ${PORT}`);
});
