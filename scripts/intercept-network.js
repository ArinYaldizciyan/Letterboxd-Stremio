/**
 * Letterboxd Network Interception Test
 *
 * Launches a headless browser against a Letterboxd watchlist page and captures
 * ALL network requests/responses. The goal is to discover whether the page
 * makes client-side API calls (e.g., to api.letterboxd.com) that return
 * structured JSON we can use — avoiding fragile HTML scraping entirely.
 *
 * Usage: node scripts/intercept-network.js [url]
 *        Defaults to https://letterboxd.com/cinemausoleum/watchlist/
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const TARGET_URL =
  process.argv[2] || "https://letterboxd.com/cinemausoleum/watchlist/";

const OUTPUT_DIR = path.join(__dirname, "..", "output");

async function run() {
  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`\n--- Letterboxd Network Interception Test ---`);
  console.log(`Target: ${TARGET_URL}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  // ── Collectors ──────────────────────────────────────────────────────
  const requests = []; // every request summary
  const jsonResponses = []; // responses with JSON content
  const xhrFetch = []; // XHR / Fetch requests specifically
  const interestingHeaders = []; // requests with auth headers

  // ── Listen to every request ─────────────────────────────────────────
  page.on("request", (req) => {
    const entry = {
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      headers: req.headers(),
    };

    requests.push(entry);

    // Flag XHR / Fetch specifically
    if (
      req.resourceType() === "xhr" ||
      req.resourceType() === "fetch"
    ) {
      xhrFetch.push(entry);
    }

    // Flag requests with authorization headers
    const headers = req.headers();
    if (headers["authorization"] || headers["x-csrf-token"]) {
      interestingHeaders.push({
        url: req.url(),
        method: req.method(),
        authorization: headers["authorization"]
          ? headers["authorization"].substring(0, 40) + "..."
          : undefined,
        csrf: headers["x-csrf-token"],
      });
    }
  });

  // ── Listen to every response ────────────────────────────────────────
  page.on("response", async (res) => {
    const contentType = res.headers()["content-type"] || "";
    const url = res.url();

    // Capture anything that looks like JSON
    if (
      contentType.includes("application/json") ||
      contentType.includes("text/json")
    ) {
      try {
        const body = await res.json();
        jsonResponses.push({
          url,
          status: res.status(),
          contentType,
          bodyPreview:
            JSON.stringify(body).substring(0, 500) +
            (JSON.stringify(body).length > 500 ? "..." : ""),
          bodyFull: body,
          bodySize: JSON.stringify(body).length,
        });
      } catch {
        jsonResponses.push({
          url,
          status: res.status(),
          contentType,
          error: "Failed to parse JSON body",
        });
      }
    }
  });

  // ── Navigate and wait for the page to load ──────────────────────────
  // Using "domcontentloaded" instead of "networkidle" because analytics
  // and tracking scripts keep connections open indefinitely.
  // Then wait a few extra seconds for any XHR/fetch calls to complete.
  console.log("Navigating to page...");
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log("DOM loaded. Waiting 5s for async requests to complete...");
  await page.waitForTimeout(5000);
  console.log("Done waiting.\n");

  // Also grab the final HTML to check for embedded JSON / script data
  const html = await page.content();

  // ── Look for embedded JSON in <script> tags ─────────────────────────
  const embeddedData = [];
  const scriptContents = await page.$$eval("script", (scripts) =>
    scripts.map((s) => ({
      type: s.type || "(none)",
      src: s.src || "(inline)",
      contentPreview: s.src ? "" : s.textContent.substring(0, 300),
    }))
  );

  for (const script of scriptContents) {
    const text = script.contentPreview;
    // Look for common SSR data patterns
    if (
      text.includes("__NEXT_DATA__") ||
      text.includes("__INITIAL_STATE__") ||
      text.includes("window.__") ||
      text.includes("application/ld+json") ||
      script.type === "application/ld+json" ||
      script.type === "application/json"
    ) {
      embeddedData.push(script);
    }
  }

  // ── Also try: does a plain HTTP GET return usable HTML? ─────────────
  // This tests whether we even need a browser at all
  let plainHttpWorks = false;
  let plainHtmlSnippet = "";
  try {
    const http = require("https");
    const plainHtml = await new Promise((resolve, reject) => {
      http.get(
        TARGET_URL,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            Accept: "text/html",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        }
      ).on("error", reject);
    });

    // Check if the plain HTML contains actual film data
    // Letterboxd uses data-film-slug on poster containers
    const hasFilmData =
      plainHtml.includes("data-film-slug") ||
      plainHtml.includes("poster-container") ||
      plainHtml.includes("film-poster");

    plainHttpWorks = hasFilmData;
    // Grab a snippet around the film data for inspection
    const filmIdx = plainHtml.indexOf("data-film-slug");
    if (filmIdx > -1) {
      plainHtmlSnippet = plainHtml.substring(
        Math.max(0, filmIdx - 100),
        filmIdx + 300
      );
    } else {
      // grab a generic snippet
      plainHtmlSnippet = plainHtml.substring(0, 500);
    }
  } catch (err) {
    plainHtmlSnippet = `Error: ${err.message}`;
  }

  // ── Report ──────────────────────────────────────────────────────────
  const report = {
    target: TARGET_URL,
    timestamp: new Date().toISOString(),

    summary: {
      totalRequests: requests.length,
      xhrFetchRequests: xhrFetch.length,
      jsonResponses: jsonResponses.length,
      requestsWithAuthHeaders: interestingHeaders.length,
      embeddedScriptDataPatterns: embeddedData.length,
      plainHttpContainsFilmData: plainHttpWorks,
    },

    plainHttpTest: {
      containsFilmData: plainHttpWorks,
      htmlSnippet: plainHtmlSnippet,
    },

    requestsByType: requests.reduce((acc, r) => {
      acc[r.resourceType] = (acc[r.resourceType] || 0) + 1;
      return acc;
    }, {}),

    requestDomains: [
      ...new Set(requests.map((r) => new URL(r.url).hostname)),
    ].sort(),

    xhrFetchRequests: xhrFetch.map((r) => ({
      method: r.method,
      url: r.url,
    })),

    jsonResponses: jsonResponses.map((r) => ({
      url: r.url,
      status: r.status,
      bodySize: r.bodySize,
      bodyPreview: r.bodyPreview,
    })),

    requestsWithAuthHeaders: interestingHeaders,

    embeddedScriptData: embeddedData,
  };

  // ── Print summary to console ────────────────────────────────────────
  console.log("=== SUMMARY ===\n");
  console.log(`Total requests:          ${report.summary.totalRequests}`);
  console.log(`XHR/Fetch requests:      ${report.summary.xhrFetchRequests}`);
  console.log(`JSON responses:          ${report.summary.jsonResponses}`);
  console.log(`Auth-header requests:    ${report.summary.requestsWithAuthHeaders}`);
  console.log(`Embedded <script> data:  ${report.summary.embeddedScriptDataPatterns}`);
  console.log(`Plain HTTP has film data: ${report.summary.plainHttpContainsFilmData}`);

  console.log(`\n=== REQUEST DOMAINS ===\n`);
  report.requestDomains.forEach((d) => console.log(`  ${d}`));

  console.log(`\n=== REQUESTS BY TYPE ===\n`);
  Object.entries(report.requestsByType).forEach(([type, count]) =>
    console.log(`  ${type}: ${count}`)
  );

  if (xhrFetch.length > 0) {
    console.log(`\n=== XHR / FETCH REQUESTS ===\n`);
    xhrFetch.forEach((r) => console.log(`  [${r.method}] ${r.url}`));
  }

  if (jsonResponses.length > 0) {
    console.log(`\n=== JSON RESPONSES ===\n`);
    jsonResponses.forEach((r) => {
      console.log(`  [${r.status}] ${r.url}`);
      console.log(`    Size: ${r.bodySize} bytes`);
      console.log(`    Preview: ${r.bodyPreview?.substring(0, 200)}`);
      console.log();
    });
  }

  if (interestingHeaders.length > 0) {
    console.log(`\n=== REQUESTS WITH AUTH HEADERS ===\n`);
    interestingHeaders.forEach((r) => {
      console.log(`  [${r.method}] ${r.url}`);
      if (r.authorization) console.log(`    Auth: ${r.authorization}`);
      if (r.csrf) console.log(`    CSRF: ${r.csrf}`);
    });
  }

  if (embeddedData.length > 0) {
    console.log(`\n=== EMBEDDED SCRIPT DATA ===\n`);
    embeddedData.forEach((s) => {
      console.log(`  Type: ${s.type} | Src: ${s.src}`);
      console.log(`  Preview: ${s.contentPreview.substring(0, 200)}`);
      console.log();
    });
  }

  console.log(`\n=== PLAIN HTTP TEST ===\n`);
  console.log(`  Film data in plain HTML: ${plainHttpWorks}`);
  console.log(`  Snippet:\n    ${plainHtmlSnippet.substring(0, 300)}`);

  // ── Write full report to file ───────────────────────────────────────
  const reportPath = path.join(OUTPUT_DIR, "network-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nFull report written to: ${reportPath}`);

  // Also write all JSON response bodies separately for inspection
  if (jsonResponses.length > 0) {
    const jsonDir = path.join(OUTPUT_DIR, "json-responses");
    fs.mkdirSync(jsonDir, { recursive: true });
    jsonResponses.forEach((r, i) => {
      if (r.bodyFull) {
        const filename = `${i}-${new URL(r.url).hostname}${new URL(r.url).pathname.replace(/\//g, "_")}.json`;
        fs.writeFileSync(
          path.join(jsonDir, filename),
          JSON.stringify(r.bodyFull, null, 2)
        );
      }
    });
    console.log(`JSON response bodies written to: ${jsonDir}/`);
  }

  await browser.close();
  console.log("\nDone.");
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
