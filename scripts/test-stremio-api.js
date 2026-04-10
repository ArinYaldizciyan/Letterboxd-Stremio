/**
 * Stremio Library API Test
 *
 * Tests the Stremio API at api.strem.io to understand:
 * 1. How login works (get authKey)
 * 2. How to read library items (datastoreGet)
 * 3. How to add a movie to the library (datastorePut)
 *
 * Usage:
 *   node scripts/test-stremio-api.js login <email> <password>
 *   node scripts/test-stremio-api.js get-library <authKey>
 *   node scripts/test-stremio-api.js add-movie <authKey> <imdbId>
 *
 * The add-movie command uses only an IMDb ID (e.g. tt0068646) to test
 * the minimum viable payload for adding a film to a user's library.
 */

const https = require("https");

const API_ENDPOINT = "https://api.strem.io";

// ── HTTP helper for Stremio API ────────────────────────────────────────
function apiRequest(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const url = new URL(`/api/${method}`, API_ENDPOINT);

    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              reject(new Error(`API error: ${JSON.stringify(json.error)}`));
            } else {
              resolve(json.result);
            }
          } catch {
            reject(new Error(`Non-JSON response (${res.statusCode}): ${data.substring(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Commands ───────────────────────────────────────────────────────────

async function login(email, password) {
  console.log(`Logging in as ${email}...`);
  const result = await apiRequest("login", { email, password });
  console.log("\n=== LOGIN RESULT ===");
  console.log("Auth Key:", result.authKey);
  console.log("User ID:", result.user?._id);
  console.log("Email:", result.user?.email);
  console.log("\nSave this authKey for subsequent commands.");
  return result;
}

async function getLibrary(authKey) {
  console.log("Fetching library metadata...");

  // Step 1: Get metadata (IDs + modification times)
  const meta = await apiRequest("datastoreMeta", {
    authKey,
    collection: "libraryItem",
  });

  console.log(`\nLibrary contains ${meta.length} items.`);
  console.log("First 5 items (meta only):");
  meta.slice(0, 5).forEach((item) => {
    console.log(`  ${item[0]} (modified: ${item[1]})`);
  });

  // Step 2: Get full data for first few items
  if (meta.length > 0) {
    const sampleIds = meta.slice(0, 3).map((m) => m[0]);
    console.log(`\nFetching full data for: ${sampleIds.join(", ")}...`);

    const items = await apiRequest("datastoreGet", {
      authKey,
      collection: "libraryItem",
      ids: sampleIds,
      all: false,
    });

    console.log("\n=== SAMPLE LIBRARY ITEMS ===");
    items.forEach((item) => {
      console.log(`\n  ${item._id}`);
      console.log(`    Name: ${item.name}`);
      console.log(`    Type: ${item.type}`);
      console.log(`    Poster: ${item.poster || "N/A"}`);
      console.log(`    Removed: ${item.removed}`);
      console.log(`    State: watched=${item.state?.timesWatched}, offset=${item.state?.timeOffset}`);
    });
  }
}

async function addMovie(authKey, imdbId) {
  // Minimum viable library item — just IMDb ID, name, and type
  // Stremio uses IMDb IDs as the primary identifier
  const now = new Date().toISOString();

  const libraryItem = {
    _id: imdbId,
    name: imdbId, // Stremio will resolve the name from metadata addons
    type: "movie",
    poster: null,
    posterShape: "poster",
    removed: false,
    temp: false,
    _ctime: now,
    _mtime: now,
    state: {
      lastWatched: null,
      timeWatched: 0,
      timeOffset: 0,
      overallTimeWatched: 0,
      timesWatched: 0,
      flaggedWatched: 0,
      duration: 0,
      video_id: null,
      watched: null,
      noNotif: false,
    },
    behaviorHints: {
      defaultVideoId: null,
      featuredVideoId: null,
      hasScheduledVideos: false,
    },
  };

  console.log(`Adding ${imdbId} to library...`);
  console.log("Payload:", JSON.stringify(libraryItem, null, 2));

  const result = await apiRequest("datastorePut", {
    authKey,
    collection: "libraryItem",
    changes: [libraryItem],
  });

  console.log("\n=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n${imdbId} should now appear in your Stremio library.`);
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "login":
      if (args.length < 2) {
        console.error("Usage: node test-stremio-api.js login <email> <password>");
        process.exit(1);
      }
      await login(args[0], args[1]);
      break;

    case "get-library":
      if (args.length < 1) {
        console.error("Usage: node test-stremio-api.js get-library <authKey>");
        process.exit(1);
      }
      await getLibrary(args[0]);
      break;

    case "add-movie":
      if (args.length < 2) {
        console.error("Usage: node test-stremio-api.js add-movie <authKey> <imdbId>");
        console.error("  e.g. node test-stremio-api.js add-movie abc123 tt0068646");
        process.exit(1);
      }
      await addMovie(args[0], args[1]);
      break;

    default:
      console.log("Stremio Library API Test");
      console.log("");
      console.log("Commands:");
      console.log("  login <email> <password>     — Get an authKey");
      console.log("  get-library <authKey>         — List library items");
      console.log("  add-movie <authKey> <imdbId>  — Add a movie to library");
      console.log("");
      console.log("Example flow:");
      console.log("  1. node scripts/test-stremio-api.js login you@email.com yourpassword");
      console.log("  2. node scripts/test-stremio-api.js get-library <authKey-from-step-1>");
      console.log("  3. node scripts/test-stremio-api.js add-movie <authKey> tt0068646");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
