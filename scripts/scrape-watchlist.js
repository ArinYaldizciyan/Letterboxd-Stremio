/**
 * Letterboxd Watchlist Scraper (No Browser Required)
 *
 * Scrapes a Letterboxd user's watchlist using plain HTTP requests and HTML
 * parsing. Fetches all pages, extracts film metadata from data attributes,
 * then enriches each film with TMDB/IMDb IDs from the individual film pages.
 *
 * Usage: node scripts/scrape-watchlist.js <watchlist-url>
 *        node scripts/scrape-watchlist.js https://letterboxd.com/cinemausoleum/watchlist/
 */

const https = require("https");
const path = require("path");
const fs = require("fs");

const OUTPUT_DIR = path.join(__dirname, "..", "output");

// ── HTTP helper ───────────────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept: "text/html,application/json",
          },
        },
        (res) => {
          // Follow redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirect = res.headers.location.startsWith("http")
              ? res.headers.location
              : `https://letterboxd.com${res.headers.location}`;
            return get(redirect).then(resolve).catch(reject);
          }
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        }
      )
      .on("error", reject);
  });
}

// ── Parse films from a single watchlist page ──────────────────────────
function parseWatchlistPage(html) {
  const films = [];
  const regex =
    /data-component-class="LazyPoster"([^>]+)>/g;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const attrs = match[1];
    const extract = (name) => {
      const m = attrs.match(new RegExp(`data-${name}="([^"]*)"`));
      return m ? m[1] : null;
    };

    films.push({
      name: extract("item-name"),
      slug: extract("item-slug"),
      filmId: extract("film-id"),
      link: extract("target-link"),
      detailsEndpoint: extract("details-endpoint"),
    });
  }

  return films;
}

// ── Detect total pages from pagination ────────────────────────────────
function getLastPage(html) {
  const matches = html.match(/\/watchlist\/page\/(\d+)/g);
  if (!matches) return 1;
  const pages = matches.map((m) => parseInt(m.match(/(\d+)/)[1], 10));
  return Math.max(...pages);
}

// ── Fetch TMDB/IMDb IDs + metadata from a film's page ─────────────────
// Note: The /film/{slug}/json/ endpoint is behind Cloudflare challenge
// protection and returns 403 for plain HTTP. Instead we extract all data
// from the film's regular HTML page which is not Cloudflare-gated.
async function enrichFilm(film) {
  try {
    const pageUrl = `https://letterboxd.com${film.link}`;
    const pageRes = await get(pageUrl);

    if (pageRes.status === 200) {
      const html = pageRes.body;

      // TMDB / IMDb IDs
      const tmdbMatch = html.match(/data-tmdb-id="(\d+)"/);
      const tmdbTypeMatch = html.match(/data-tmdb-type="(\w+)"/);
      const imdbMatch = html.match(/imdb\.com\/title\/(tt\d+)/);

      film.tmdbId = tmdbMatch ? parseInt(tmdbMatch[1], 10) : null;
      film.tmdbType = tmdbTypeMatch ? tmdbTypeMatch[1] : null;
      film.imdbId = imdbMatch ? imdbMatch[1] : null;

      // Release year
      const yearMatch = html.match(/href="\/films\/year\/(\d{4})\//);
      film.releaseYear = yearMatch ? parseInt(yearMatch[1], 10) : null;

      // Runtime
      const runtimeMatch = html.match(/(\d+)&nbsp;mins/);
      film.runTime = runtimeMatch ? parseInt(runtimeMatch[1], 10) : null;

      // Directors — extract from JSON-LD structured data
      const directorJsonLd = html.match(/"name":"([^"]+)","sameAs":"\/director/g);
      if (directorJsonLd) {
        film.directors = directorJsonLd.map(
          (d) => d.match(/"name":"([^"]+)"/)[1]
        );
      } else {
        film.directors = [];
      }
    }
  } catch (err) {
    film.enrichError = err.message;
  }

  return film;
}

// ── Main ──────────────────────────────────────────────────────────────
async function run() {
  const inputUrl = process.argv[2];
  if (!inputUrl) {
    console.error(
      "Usage: node scripts/scrape-watchlist.js <letterboxd-watchlist-url>"
    );
    console.error(
      "  e.g. node scripts/scrape-watchlist.js https://letterboxd.com/cinemausoleum/watchlist/"
    );
    process.exit(1);
  }

  // Normalize URL
  const baseUrl = inputUrl.replace(/\/$/, "");

  console.log(`\n--- Letterboxd Watchlist Scraper ---`);
  console.log(`Target: ${baseUrl}\n`);

  // Step 1: Fetch page 1 to get film list + total page count
  console.log("Fetching page 1...");
  const page1 = await get(`${baseUrl}/`);
  if (page1.status !== 200) {
    console.error(`Failed to fetch watchlist: HTTP ${page1.status}`);
    process.exit(1);
  }

  const lastPage = getLastPage(page1.body);
  let allFilms = parseWatchlistPage(page1.body);
  console.log(`  Found ${allFilms.length} films on page 1 (${lastPage} pages total)`);

  // Step 2: Fetch remaining pages
  for (let p = 2; p <= lastPage; p++) {
    const url = `${baseUrl}/page/${p}/`;
    console.log(`Fetching page ${p}/${lastPage}...`);
    const res = await get(url);
    if (res.status === 200) {
      const films = parseWatchlistPage(res.body);
      console.log(`  Found ${films.length} films on page ${p}`);
      allFilms = allFilms.concat(films);
    } else {
      console.warn(`  Warning: page ${p} returned HTTP ${res.status}`);
    }
  }

  console.log(`\nTotal films scraped: ${allFilms.length}`);

  // Step 3: Enrich each film with TMDB/IMDb IDs
  // Process in batches to be respectful of Letterboxd's servers
  const BATCH_SIZE = 5;
  console.log(
    `\nEnriching films with TMDB/IMDb IDs (${BATCH_SIZE} concurrent)...`
  );

  for (let i = 0; i < allFilms.length; i += BATCH_SIZE) {
    const batch = allFilms.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(enrichFilm));
    const done = Math.min(i + BATCH_SIZE, allFilms.length);
    process.stdout.write(`  ${done}/${allFilms.length}\r`);
  }
  console.log();

  // Step 4: Build output
  const username = baseUrl.match(/letterboxd\.com\/([^/]+)/)?.[1] || "unknown";

  const output = {
    meta: {
      username,
      url: baseUrl,
      scrapedAt: new Date().toISOString(),
      totalFilms: allFilms.length,
      totalPages: lastPage,
    },
    films: allFilms,
  };

  // Stats
  const withTmdb = allFilms.filter((f) => f.tmdbId).length;
  const withImdb = allFilms.filter((f) => f.imdbId).length;
  const withDirectors = allFilms.filter(
    (f) => f.directors && f.directors.length
  ).length;

  console.log(`\n=== RESULTS ===`);
  console.log(`  Total films:     ${allFilms.length}`);
  console.log(`  With TMDB ID:    ${withTmdb}/${allFilms.length}`);
  console.log(`  With IMDb ID:    ${withImdb}/${allFilms.length}`);
  console.log(`  With directors:  ${withDirectors}/${allFilms.length}`);

  // Print first 5 films as preview
  console.log(`\n=== PREVIEW (first 5) ===\n`);
  allFilms.slice(0, 5).forEach((f) => {
    console.log(`  ${f.name}`);
    console.log(`    Slug: ${f.slug}`);
    console.log(`    TMDB: ${f.tmdbId || "N/A"}  IMDb: ${f.imdbId || "N/A"}`);
    console.log(
      `    Year: ${f.releaseYear || "N/A"}  Runtime: ${f.runTime || "N/A"}min`
    );
    console.log(
      `    Directors: ${f.directors?.join(", ") || "N/A"}`
    );
    console.log();
  });

  // Write output
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `watchlist-${username}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Full output written to: ${outputPath}`);
  console.log("Done.");
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
