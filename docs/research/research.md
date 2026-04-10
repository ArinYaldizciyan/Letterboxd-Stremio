# Letterboxd-Stremio Watchlist Sync — Feasibility Research

**Date:** 2026-04-09
**Ticket:** SHV-38
**Status:** Research Complete

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Project Goal](#project-goal)
3. [Letterboxd Data Access](#letterboxd-data-access)
4. [Stremio Integration](#stremio-integration)
5. [Existing Solutions](#existing-solutions)
6. [Architecture Options](#architecture-options)
7. [ID Mapping & Data Flow](#id-mapping--data-flow)
8. [Roadblockers & Risks](#roadblockers--risks)
9. [Requirements](#requirements)
10. [Recommendation](#recommendation)
11. [Scaling Analysis: Headless Browser Scraping](#scaling-analysis-headless-browser-scraping)
12. [Network Interception: Bypassing HTML Scraping](#network-interception-bypassing-html-scraping)
13. [Existing Scraping Libraries](#existing-scraping-libraries)
14. [Updated Recommendation](#updated-recommendation)

---

## Executive Summary

**Is this project feasible? Yes — with caveats.**

The core goal of syncing a Letterboxd watchlist to Stremio is achievable and has already been proven by existing projects like [Stremboxd](https://stremboxd.com/) and [Letterboxd Stremio Addon](https://letterboxd.almosteffective.com/configure). However, the approach must work around a key constraint: **Letterboxd's API is in private beta and not available to the general public**. The proven workaround is **web scraping of public Letterboxd profiles**, which is the approach all existing community tools use.

On the Stremio side, the most practical path is building a **Stremio addon that serves Letterboxd watchlist data as a catalog** — this is well-supported by the addon SDK and does not require direct manipulation of the user's Stremio library. A cron-based sync can be implemented to periodically re-scrape the Letterboxd watchlist and serve updated catalog data.

---

## Project Goal

The user stories under consideration:

1. User connects their Letterboxd account to our service
2. User connects their Stremio account to our service
3. When user adds an item to their Letterboxd watchlist, it gets synced to their Stremio watchlist
4. Sync doesn't need to be immediate — cron-based is acceptable

---

## Letterboxd Data Access

### Official API (Private Beta)

- **URL:** https://letterboxd.com/api-beta/
- **Docs:** https://api-docs.letterboxd.com/
- **Status:** Available by request only. Must email `api@letterboxd.com` with details of intended use.
- **Wait time:** Reports indicate requests can take months, and many go unanswered.
- **Auth:** Standard OAuth2 flows (Password, Client Credentials, Authorization Code, Refresh Token). Password flow is first-party only.
- **Capabilities:** Full access to watchlists, member data, film metadata, lists, etc. Cursor pagination with 100,000 object limit.
- **Verdict:** Ideal but not reliably obtainable. Should apply for access but not depend on it.

### Web Scraping (Primary Alternative)

- **Watchlist URL pattern:** `https://letterboxd.com/{username}/watchlist/`
- **Public profiles:** Watchlists are publicly accessible by default (unless user sets them private).
- **Data available:** Film titles, Letterboxd URIs, poster images, and links to individual film pages.
- **TMDB/IMDb IDs:** Not directly on watchlist pages, but each film page links to TMDB and IMDb. Can also be resolved via TMDB search API.
- **Pagination:** Watchlist pages are paginated (e.g., `/watchlist/page/2/`).
- **JavaScript requirement:** As of February 2026, Letterboxd requires JavaScript to load site data. This means simple HTTP requests (requests/BeautifulSoup) may not work — **headless browser (Playwright/Puppeteer) or similar may be needed**.
- **Existing scrapers:** Many open-source scrapers exist on GitHub ([L-Dot/Letterboxd-list-scraper](https://github.com/L-Dot/Letterboxd-list-scraper), [ZerioDev/Letterboxd-scraper](https://github.com/ZerioDev/Letterboxd-scraper), etc.).
- **Rate limiting:** No documented rate limits for scraping, but aggressive scraping could trigger blocks.

### RSS Feeds

- **Diary RSS:** Available at `https://letterboxd.com/{username}/rss/` — covers diary entries (watched films), NOT watchlist.
- **Watchlist RSS:** **Not officially available.** Community tools like [letterboxd-rss](https://github.com/janw/letterboxd-rss) generate watchlist RSS by scraping.
- **Data in RSS:** Includes TMDB IDs in diary feeds but limited metadata.
- **Verdict:** Useful for diary/watched activity sync but insufficient for watchlist sync without scraping.

### CSV Export

- **Available:** Yes, Letterboxd allows manual CSV export of watchlist data.
- **Limitation:** Does not include TMDB IDs. Includes Letterboxd URI, title, and year.
- **Verdict:** Not suitable for automated sync — requires manual user action.

### Summary of Letterboxd Access Methods

| Method | Watchlist Access | Auto-Sync Capable | TMDB IDs | Reliability |
|--------|-----------------|-------------------|----------|-------------|
| Official API | Yes | Yes | Yes | Best, but access denied |
| Web Scraping | Yes | Yes | Via lookup | Medium (fragile) |
| RSS Feed | Diary only | Yes | In diary feed | Good for diary |
| CSV Export | Yes | No (manual) | No | N/A |

---

## Stremio Integration

### Approach 1: Stremio Addon (Catalog) — RECOMMENDED

The Stremio Addon SDK allows building addons that serve **custom catalogs** visible in Stremio's Board, Discover, and Search sections.

- **SDK:** https://github.com/Stremio/stremio-addon-sdk (Node.js, with community ports in Python, Go, Rust, etc.)
- **Protocol:** Addons serve JSON at `/{resource}/{type}/{id}.json` endpoints.
- **Catalog resource:** Returns an array of "meta preview" objects (id, name, type, poster, etc.).
- **User-specific config:** Addons support `behaviorHints.configurable` and `behaviorHints.configurationRequired` — user data (like Letterboxd username) is embedded in the addon URL (e.g., `https://myaddon.com/{letterboxd_username}/manifest.json`).
- **No Stremio auth needed:** The addon simply serves catalogs. No need to authenticate with Stremio or modify the user's library directly.
- **How it works:** User provides their Letterboxd username during addon configuration → addon scrapes their watchlist → serves it as a browsable catalog in Stremio.

This is exactly how Stremboxd, the Letterboxd addon by almosteffective, and similar tools work.

### Approach 2: Direct Library Manipulation via Stremio API

Stremio has an internal API at `https://api.strem.io` with datastore operations:

- **`datastorePut`**: Can add items to user's library collection.
- **`datastoreGet`**: Can read library items.
- **`datastoreMeta`**: Gets metadata about library items.
- **Auth:** Requires Stremio auth key (from login/register).
- **Library items** require: id (IMDb format `tt{id}`), name, type, poster, and state tracking.

This approach would add movies directly to the user's Stremio library/watchlist, but:
- Requires user's Stremio credentials or auth token.
- API is internal/undocumented — no guarantees of stability.
- More complex to implement and maintain.
- Privacy/security concerns with handling Stremio credentials.

### Approach 3: Hybrid (Catalog + Optional Library Sync)

Serve the Letterboxd watchlist as a catalog (Approach 1), and optionally offer direct library sync (Approach 2) for users willing to authenticate with Stremio.

### Stremio Integration Summary

| Approach | Complexity | User Auth Required | Reliability | UX |
|----------|-----------|-------------------|-------------|-----|
| Addon Catalog | Low | None (Stremio) | High | Good — shows as browsable catalog |
| Direct Library API | High | Stremio credentials | Medium (undocumented API) | Best — appears in library |
| Hybrid | Medium-High | Optional | Medium-High | Best of both |

---

## Existing Solutions

### 1. Stremboxd (https://stremboxd.com/)

- **Author:** esp4ce ([GitHub](https://github.com/esp4ce/stremio-letterboxd-addon))
- **Stack:** Next.js, React, Tailwind CSS, Fastify, SQLite
- **Features:** Watchlist, diary, ratings, friends activity, lists, search, rate/like/watched toggle from Stremio
- **Modes:**
  - **Public mode:** Just enter username. Access popular films, Top 250, public watchlists, lists.
  - **Full mode:** Login with Letterboxd credentials. Unlocks diary, friends, quick actions. Supports 2FA.
- **Approach:** Likely uses a combination of scraping and the Letterboxd login session for authenticated features.
- **Status:** Active and widely used.

### 2. Letterboxd Addon by almosteffective.com

- **URL:** https://letterboxd.almosteffective.com/configure
- **Features:** Add Letterboxd lists as Stremio catalogs, watchlist access, filtering by directors/writers.
- **Approach:** Catalog-based addon.

### 3. letterboxd-stremio-addon (Pigamer37)

- **GitHub:** https://github.com/Pigamer37/letterboxd-stremio-addon
- **Status:** Proof-of-concept / learning project.
- **Blocker:** Developer explicitly notes "The Letterboxd API is not yet available for personal projects."
- **Approach:** Attempted to log Stremio watch activity to Letterboxd (reverse direction).

### 4. Custom Lists Pro

- **URL:** https://docs.stremiocustomlists.com/
- **Features:** Import lists from Trakt, TMDB, IMDb, Letterboxd, and more.
- **Approach:** Multi-source catalog addon.

### 5. mdblist

- **Features:** Creates and syncs watchlists from multiple sources (IMDb, TMDB, Trakt, Letterboxd) and presents them in Stremio.
- **Approach:** Intermediary service that aggregates lists.

### Key Takeaway

Multiple existing projects have successfully implemented Letterboxd → Stremio watchlist sync. **This is a solved problem** from a feasibility standpoint. The question is whether we want to build our own or leverage/extend existing tools.

---

## ID Mapping & Data Flow

### The ID Problem

- **Letterboxd** uses its own internal IDs and URIs (e.g., `/film/the-godfather/`).
- **Letterboxd** sources all film data from **TMDB** (The Movie Database).
- **Stremio** primarily uses **IMDb IDs** (e.g., `tt0068646`) for content identification.
- Letterboxd pages contain links to both TMDB and IMDb pages, but the watchlist HTML doesn't directly expose these IDs.

### Resolution Strategy

1. Scrape Letterboxd watchlist → get film slugs/titles
2. For each film, either:
   - Scrape the individual film page to extract TMDB/IMDb links, OR
   - Use the **TMDB API** (free, well-documented) to search by title+year → get IMDb ID
3. Use the IMDb ID (e.g., `tt0068646`) as the Stremio meta item ID

### Data Flow (Cron-Based)

```
[Cron Job / Scheduler]
        |
        v
[Scrape Letterboxd Watchlist]
  letterboxd.com/{user}/watchlist/
        |
        v
[Extract Film Titles + Slugs]
        |
        v
[Resolve TMDB/IMDb IDs]
  (via TMDB API or film page scrape)
        |
        v
[Cache/Store Results]
  (SQLite / Redis / JSON)
        |
        v
[Stremio Addon Server]
  Serves catalog at /{user}/catalog/movie/letterboxd-watchlist.json
        |
        v
[Stremio Client]
  Displays watchlist as browsable catalog
```

---

## Roadblockers & Risks

### Critical

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Letterboxd API access denied** | High | Plan for scraping as primary approach. Apply for API access in parallel. |
| **Letterboxd JS-rendering requirement** | High | Use headless browser (Playwright/Puppeteer) instead of simple HTTP requests. Increases resource usage and complexity. |
| **Letterboxd HTML structure changes** | Medium | Scraping is inherently fragile. Monitor for breakage. Consider multiple selectors and fallback strategies. |

### Moderate

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Private watchlists** | Medium | Public watchlists only (unless API access is granted or user provides credentials). Clearly communicate this limitation. |
| **Rate limiting / IP blocking** | Medium | Implement respectful scraping intervals, caching, and backoff strategies. |
| **TMDB API rate limits** | Low | TMDB API is generous (free tier). Cache results aggressively. |
| **ID resolution failures** | Low | Fuzzy matching on title+year. Fall back to manual resolution. |

### Low

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Stremio addon SDK changes** | Low | SDK is stable and well-maintained. |
| **Letterboxd ToS concerns** | Medium | Review ToS regarding scraping. Many projects do this without issue, but not risk-free. |
| **Stremio internal API instability** | Medium | Only relevant if using Approach 2 (direct library manipulation). Stick with Approach 1. |

---

## Requirements

### Must Have

- [ ] Letterboxd username input (configuration page)
- [ ] Watchlist scraping capability (with JS rendering support)
- [ ] TMDB/IMDb ID resolution for scraped films
- [ ] Stremio addon serving watchlist as a catalog
- [ ] Cron-based periodic sync (configurable interval)
- [ ] Caching layer to avoid excessive scraping

### Should Have

- [ ] Error handling and logging
- [ ] Support for paginated watchlists (users with 100+ films)
- [ ] Poster images in catalog entries
- [ ] Metadata enrichment (year, genre, rating) via TMDB API

### Could Have

- [ ] Support for other Letterboxd lists (not just watchlist)
- [ ] Bi-directional sync (mark watched in Stremio → update Letterboxd)
- [ ] Direct Stremio library integration (Approach 2)
- [ ] Letterboxd login support for private watchlists
- [ ] Multiple user support
- [ ] Webhook/notification on sync completion

### Won't Have (Initial Release)

- [ ] Real-time sync (webhook from Letterboxd — not available)
- [ ] Official Letterboxd API integration (unless access is granted)

---

## Recommendation

### Recommended Approach: Stremio Addon with Cron-Based Scraping

**Architecture:**

1. **Web service** (Node.js or Python) that:
   - Hosts a configuration page where users enter their Letterboxd username
   - Generates a user-specific addon manifest URL
   - Scrapes the user's Letterboxd watchlist on a cron schedule
   - Resolves film IDs via TMDB API
   - Caches results in SQLite or similar
   - Serves the watchlist as a Stremio catalog

2. **Stremio Addon** that:
   - Implements the catalog resource
   - Returns the cached watchlist data as meta preview items
   - Supports the standard addon protocol

3. **Cron scheduler** that:
   - Periodically refreshes each registered user's watchlist
   - Configurable interval (e.g., every 15–60 minutes)
   - Handles errors gracefully with retry logic

### Why This Approach

- **Proven:** This is exactly how Stremboxd and similar tools work.
- **No API access needed:** Scraping handles the Letterboxd side.
- **No Stremio auth needed:** Catalog-based approach doesn't require user credentials.
- **Simple deployment:** Single service handles both scraping and addon serving.
- **Extensible:** Can add more features (lists, diary, etc.) incrementally.

### Tech Stack Suggestions

- **Runtime:** Node.js (best ecosystem support for Stremio addon SDK) or Python
- **Scraping:** Playwright or Puppeteer (for JS-rendered pages)
- **Database:** SQLite (simple, no external deps) or PostgreSQL (if scaling)
- **Scheduling:** node-cron, Bull queue, or external scheduler
- **TMDB API:** Free API key from https://www.themoviedb.org/settings/api
- **Hosting:** Any Node.js host (Vercel, Railway, Fly.io, VPS)

### Next Steps

1. Apply for Letterboxd API access (email `api@letterboxd.com`)
2. Get a TMDB API key
3. Prototype the Letterboxd watchlist scraper
4. Build a minimal Stremio addon serving a hardcoded catalog
5. Connect scraper → cache → addon
6. Add cron scheduling
7. Build configuration page
8. Deploy and test end-to-end

---

## Scaling Analysis: Headless Browser Scraping

### The Core Problem

If we need to scrape every registered user's Letterboxd watchlist daily via a headless browser, each scrape involves spinning up a browser context, navigating to the page, waiting for JS to render, and parsing the result. This is **10-50x more resource-intensive** than a simple HTTP request.

| Metric | Simple HTTP Request | Headless Browser |
|--------|-------------------|------------------|
| Time per page | 0.5–2 seconds | 3–15 seconds |
| Memory per session | ~10 MB | 50–150 MB (new instance) or ~KB (shared context) |
| CPU usage | Minimal | Significant (JS engine) |
| Bandwidth | HTML only | HTML + CSS + JS + images |

### Scaling Strategies

**Browser Contexts (not instances) — Critical Optimization:**

Rather than launching a new browser process per user, Playwright/Puppeteer support **browser contexts** — lightweight, isolated sessions within a single browser process. Creating a context takes single-digit milliseconds and negligible memory (KB, not MB). A single browser process can host **20-50+ concurrent contexts**.

Architecture:
```
[Single Chromium Process]
  ├── Context 1 → Scrape user_A's watchlist
  ├── Context 2 → Scrape user_B's watchlist
  ├── Context 3 → Scrape user_C's watchlist
  └── ... (up to ~50 contexts)
```

**Estimated throughput with context pooling:**

| Users | Strategy | Est. Time (daily cron) | Est. Memory |
|-------|----------|----------------------|-------------|
| 10 | 1 browser, sequential | ~2-5 min | ~200 MB |
| 100 | 1 browser, 10 concurrent contexts | ~5-15 min | ~300 MB |
| 1,000 | 2-3 browsers, 20 contexts each | ~30-60 min | ~1 GB |
| 10,000 | Browser pool (5-10 instances) | ~2-5 hours | ~3-5 GB |

**Additional optimization: block unnecessary resources.** Via `page.route()`, block images, fonts, CSS, analytics, and ads — we only need the DOM/JSON data. This can cut page load time by 50-70%.

### Scaling Risks

- **Crash blast radius:** If a browser process crashes, all 20-50 contexts in it die. Need retry logic.
- **Memory leaks:** Chromium leaks memory over time. Must recycle browser instances periodically.
- **IP rate limiting:** Letterboxd may throttle or block an IP making hundreds of requests. May need proxy rotation at scale.
- **Cost:** At 10,000+ users, a VPS with 4-8 GB RAM and dedicated CPU is needed. Cloud browser services (Browserless.io, etc.) charge ~$0.01-0.05 per page.

---

## Network Interception: Bypassing HTML Scraping

### The Insight (User's Question)

> If JavaScript is used, that means it's likely a JS call is querying an API to populate the page. Could we intercept this JSON response similar to the browser's Network tab?

**This is exactly the right intuition, and yes — Playwright supports this natively.**

### How Letterboxd Loads Data

Letterboxd's architecture:
- **Backend:** Java on Apache Tomcat with PostgreSQL
- **API:** `https://api.letterboxd.com/api/v0/` — the same API used by mobile apps
- **Website:** The site uses JavaScript to make calls that populate the page with data

The key question is: **does the website's JavaScript call `api.letterboxd.com` directly from the browser, or does the server render the HTML and send it pre-populated?**

Based on research:
- The **mobile apps** definitely call `api.letterboxd.com` directly (confirmed via [mitmproxy interception](https://blog.alexbeals.com/posts/extracting-letterboxd-tokens-with-mitmproxy))
- The **website** appears to use a hybrid approach — some content is server-rendered, but dynamic features (like the "require JavaScript" warning) suggest client-side API calls are also made
- The API uses OAuth2 Bearer tokens with a `client_id` and `client_secret` embedded in the app/site

### Three Interception Strategies

#### Strategy 1: Intercept XHR/Fetch Responses (Best Case)

If the browser JS calls `api.letterboxd.com`, we can capture the JSON response directly:

```javascript
// Playwright - listen for API responses
const watchlistData = [];
page.on('response', async (response) => {
  const url = response.url();
  if (url.includes('api.letterboxd.com') && url.includes('watchlist')) {
    const json = await response.json();
    watchlistData.push(json);
  }
});
await page.goto('https://letterboxd.com/username/watchlist/');
// watchlistData now contains the raw API JSON — no HTML parsing needed
```

**Advantages:**
- Clean, structured JSON data (includes TMDB IDs, metadata, everything)
- No fragile CSS selector parsing
- Much more resilient to UI changes (API contracts are more stable than HTML)
- Could potentially extract the `client_id`/`client_secret` and call the API directly without a browser at all

**Risks:**
- If Letterboxd serves pre-rendered HTML (SSR) without client-side API calls, there's nothing to intercept
- Letterboxd could change/obfuscate their internal API calls
- Using extracted API credentials may violate ToS

#### Strategy 2: Extract API Credentials (Highest Reward, Highest Risk)

The [mitmproxy blog post](https://blog.alexbeals.com/posts/extracting-letterboxd-tokens-with-mitmproxy) demonstrates that Letterboxd apps use:
- `client_id` and `client_secret` for OAuth2 authentication
- `POST https://api.letterboxd.com/api/v0/auth/token` to get access tokens
- Access tokens expire after 3600 seconds (1 hour)
- Refresh tokens persist indefinitely

If we could extract the website's `client_id`/`client_secret` from the JavaScript bundle:
1. Call `/auth/token` with Client Credentials grant → get access token
2. Call `/member/{id}/watchlist` directly → get JSON watchlist data
3. **No browser needed at all** — pure HTTP requests, scales trivially

**This would completely eliminate the headless browser scaling problem.**

However:
- Using extracted credentials is likely against Letterboxd's ToS
- Letterboxd could rotate credentials and break this approach
- Ethically questionable — we'd be using their private API without permission

#### Strategy 3: HTML Interception (Fallback)

Even if no client-side API calls are made, Playwright can still intercept the **server's HTML response** before it reaches the browser renderer:

```javascript
// Intercept the initial HTML response
page.on('response', async (response) => {
  if (response.url().includes('/watchlist') && response.headers()['content-type']?.includes('text/html')) {
    const html = await response.text();
    // Parse HTML server-side without waiting for JS rendering
  }
});
```

This is still faster than waiting for full page render, but doesn't give us structured JSON.

### Recommended Interception Approach

**Phase 1: Prototype and observe.** Launch Playwright against a Letterboxd watchlist page with full network logging. Identify exactly what requests the browser makes. Look for:
- Calls to `api.letterboxd.com`
- Calls to any `/ajax/` or JSON endpoints on `letterboxd.com`
- Embedded JSON in `<script>` tags (common SSR pattern: `__NEXT_DATA__`, `window.__STATE__`, etc.)

**Phase 2: Optimize based on findings.**
- If client-side API calls exist → intercept JSON responses (Strategy 1)
- If embedded JSON in HTML → parse it directly, no full render needed
- If pure SSR HTML → fall back to HTML parsing with selectors

### Impact on Scaling

If network interception works (Strategy 1 or 2), the scaling picture changes dramatically:

| Approach | Per-user cost | 1,000 users daily | 10,000 users daily |
|----------|--------------|-------------------|-------------------|
| Full headless render + parse | 5-15s, ~50MB | ~30-60 min, 1GB | Hours, 5GB+ |
| Network interception (browser) | 2-5s, ~50MB | ~15-30 min, 1GB | ~1-2 hours, 5GB+ |
| Direct API calls (no browser) | 0.5-2s, ~10MB | ~2-5 min, trivial | ~10-30 min, trivial |
| Simple HTTP + parse (if works) | 0.5-2s, ~10MB | ~2-5 min, trivial | ~10-30 min, trivial |

---

## Existing Scraping Libraries

Several Python libraries currently scrape Letterboxd successfully using **simple HTTP requests** (no headless browser):

### letterboxdpy ([GitHub](https://github.com/nmcassa/letterboxdpy))

- Active project with 688 commits
- Web scraper using HTTP requests (requests + BeautifulSoup)
- Has a dedicated `Watchlist` module — `Watchlist("username")` returns movies with slugs, names, years
- Lazy-loads movie data on access
- **No headless browser required** — suggesting simple HTTP scraping may still work for watchlists

### Letterboxd-list-scraper ([GitHub](https://github.com/L-Dot/Letterboxd-list-scraper))

- Uses requests + BeautifulSoup + lxml
- Explicitly supports watchlists
- Scrapes ~1.2 films/second
- Last release June 2024 (v2.2.0)

### Key Implication

**The "JavaScript required" warning may not apply to all pages, or these libraries may still work despite it.** This needs to be validated with a quick test. If simple HTTP requests still work for watchlist pages, the entire headless browser concern is moot and scaling becomes trivial.

---

## Updated Recommendation

### First Step: Validate Scraping Approach

Before committing to a headless browser architecture, **prototype a simple HTTP scraper** for a Letterboxd watchlist. If `requests` + BeautifulSoup work, the project becomes significantly simpler and cheaper to scale.

### If Simple HTTP Works → Lightweight Architecture
- Standard HTTP requests in a cron job
- No browser dependencies, minimal resource usage
- Scales to thousands of users on a $5/month VPS

### If Headless Browser Required → Network Interception First
1. Profile the Letterboxd watchlist page's network requests
2. If client-side API calls exist → intercept JSON, potentially extract credentials for direct API access
3. If no API calls → use browser context pooling with resource blocking
4. Consider cloud browser services (Browserless.io) at scale

### If Direct API Access Possible → Best Case
- Apply for official Letterboxd API access in parallel
- If not granted, evaluate the ethics/risk of using extracted credentials
- Pure HTTP-based sync, trivial scaling, clean data

---

## Sources

- [Letterboxd API Beta](https://letterboxd.com/api-beta/)
- [Letterboxd API Documentation](https://api-docs.letterboxd.com/)
- [Stremio Addon SDK](https://github.com/Stremio/stremio-addon-sdk)
- [Stremio Addon SDK Documentation](https://stremio.github.io/stremio-addon-sdk/)
- [Stremio Addon Protocol](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md)
- [Stremio API Client](https://github.com/Stremio/stremio-api-client)
- [Stremio Core - Library Management](https://deepwiki.com/Stremio/stremio-core/3.1-library-management)
- [Stremio Core - API Integration](https://deepwiki.com/Stremio/stremio-core/5.2-api-integration)
- [Stremboxd](https://stremboxd.com/) — [GitHub](https://github.com/esp4ce/stremio-letterboxd-addon)
- [letterboxd-stremio-addon by Pigamer37](https://github.com/Pigamer37/letterboxd-stremio-addon)
- [Letterboxd Film Data Source](https://letterboxd.com/about/film-data/)
- [letterboxd-rss](https://github.com/janw/letterboxd-rss)
- [Letterboxd List Scraper](https://github.com/L-Dot/Letterboxd-list-scraper)
- [Radarr Letterboxd Integration Issue](https://github.com/Radarr/Radarr/issues/3228)
- [Stremio Trakt 2-Way Sync Blog Post](https://blog.stremio.com/stremio-tech-update-28-trakt-scrobbling-2-way-sync-more/)
- [Stremio Addon Advanced Docs](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/advanced.md)
- [Letterboxd Watchlist Scrapper](https://github.com/skukhniy/letterboxd-watchlist-scrapper)
- [Getting Letterboxd API Access with mitmproxy](https://blog.alexbeals.com/posts/extracting-letterboxd-tokens-with-mitmproxy)
- [letterboxdpy - Python Letterboxd Scraper](https://github.com/nmcassa/letterboxdpy)
- [Playwright Network Interception Docs](https://playwright.dev/docs/network)
- [Scaling Headless Browsers: Contexts vs Instances](https://dev.to/deepak_mishra_35863517037/scaling-headless-browsers-managing-contexts-vs-instances-1d73)
- [Challenges of Scaling Playwright/Puppeteer](https://www.zyte.com/blog/challenges-of-scaling-playwright-and-puppeteer-for-web-scraping/)
