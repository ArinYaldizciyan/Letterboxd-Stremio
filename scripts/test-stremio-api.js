/**
 * Stremio Library API Test
 *
 * Tests the Stremio API at api.strem.io:
 * 1. Login with STREMIO_EMAIL + STREMIO_PASSWORD → get authKey
 * 2. Read library items (datastoreMeta + datastoreGet)
 * 3. Add a movie by IMDb ID (datastorePut)
 *
 * Credentials come from environment variables (set by GitHub Actions
 * secrets or a local .env file).
 *
 * Usage:
 *   node scripts/test-stremio-api.js login
 *   node scripts/test-stremio-api.js get-library
 *   node scripts/test-stremio-api.js add-movie <imdbId>
 *   node scripts/test-stremio-api.js full-test <imdbId>   (login + get + add)
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const API_ENDPOINT = "https://api.strem.io";
const ENV_PATH = path.join(__dirname, "..", ".env");

// ── Load .env if present (GitHub Actions injects env vars directly) ───
if (fs.existsSync(ENV_PATH)) {
  const lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// ── HTTP helper ────────────────────────────────────────────────────────
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
            reject(
              new Error(
                `Non-JSON response (${res.statusCode}): ${data.substring(0, 200)}`
              )
            );
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

async function login() {
  const email = process.env.STREMIO_EMAIL;
  const password = process.env.STREMIO_PASSWORD;

  if (!email || !password) {
    console.error("Missing STREMIO_EMAIL or STREMIO_PASSWORD env vars.");
    console.error("Set them in .env or as environment variables.");
    process.exit(1);
  }

  console.log(`Logging in as ${email}...`);
  const result = await apiRequest("login", { email, password });

  console.log("\n=== LOGIN RESULT ===");
  console.log("Auth Key:", result.authKey);
  console.log("User ID:", result.user?._id);
  console.log("Email:", result.user?.email);

  // Persist authKey to .env for subsequent local runs
  if (!process.env.CI) {
    let content = fs.existsSync(ENV_PATH)
      ? fs.readFileSync(ENV_PATH, "utf-8")
      : "";
    const regex = /^STREMIO_AUTH_KEY=.*$/m;
    const line = `STREMIO_AUTH_KEY=${result.authKey}`;
    content = regex.test(content)
      ? content.replace(regex, line)
      : content.trimEnd() + `\n${line}\n`;
    fs.writeFileSync(ENV_PATH, content);
    console.log("\nAuth key saved to .env as STREMIO_AUTH_KEY.");
  }

  return result.authKey;
}

function requireAuthKey() {
  const authKey = process.env.STREMIO_AUTH_KEY;
  if (!authKey) {
    console.error("Missing STREMIO_AUTH_KEY env var. Run 'login' first.");
    process.exit(1);
  }
  return authKey;
}

async function getLibrary(authKey) {
  console.log("Fetching library metadata...");

  const meta = await apiRequest("datastoreMeta", {
    authKey,
    collection: "libraryItem",
  });

  console.log(`\nLibrary contains ${meta.length} items.`);
  console.log("First 10 items (ID + modified):");
  meta.slice(0, 10).forEach((item) => {
    console.log(`  ${item[0]}  (modified: ${item[1]})`);
  });

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
      console.log(
        `    State: watched=${item.state?.timesWatched}, offset=${item.state?.timeOffset}`
      );
    });
  }

  return meta;
}

async function addMovie(authKey, imdbId) {
  const now = new Date().toISOString();

  const libraryItem = {
    _id: imdbId,
    name: imdbId, // Stremio resolves display name from Cinemeta
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
  const result = await apiRequest("datastorePut", {
    authKey,
    collection: "libraryItem",
    changes: [libraryItem],
  });

  console.log("Result:", JSON.stringify(result, null, 2));
  console.log(`\n${imdbId} added to Stremio library.`);
  return result;
}

async function removeMovie(authKey, imdbId) {
  // "Remove" in Stremio means setting removed: true, not deleting
  const now = new Date().toISOString();

  const libraryItem = {
    _id: imdbId,
    name: imdbId,
    type: "movie",
    poster: null,
    posterShape: "poster",
    removed: true,
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

  console.log(`Removing ${imdbId} from library...`);
  const result = await apiRequest("datastorePut", {
    authKey,
    collection: "libraryItem",
    changes: [libraryItem],
  });

  console.log("Result:", JSON.stringify(result, null, 2));
  console.log(`\n${imdbId} marked as removed.`);
  return result;
}

// ── Full integration test ──────────────────────────────────────────────
async function fullTest(imdbId) {
  console.log("=== FULL STREMIO API TEST ===\n");

  // 1. Login
  console.log("--- Step 1: Login ---");
  const authKey = await login();

  // 2. Read library
  console.log("\n--- Step 2: Read library ---");
  const meta = await getLibrary(authKey);

  // 3. Check if the movie is already in the library
  const alreadyExists = meta.some((m) => m[0] === imdbId);
  console.log(`\n--- Step 3: Add movie (${imdbId}) ---`);
  if (alreadyExists) {
    console.log(`${imdbId} is already in the library, adding anyway (updates mtime).`);
  }
  await addMovie(authKey, imdbId);

  // 4. Verify it was added
  console.log("\n--- Step 4: Verify ---");
  const verify = await apiRequest("datastoreGet", {
    authKey,
    collection: "libraryItem",
    ids: [imdbId],
    all: false,
  });

  if (verify.length > 0 && !verify[0].removed) {
    console.log(`Verified: ${imdbId} is in the library.`);
    console.log(`  Name: ${verify[0].name}`);
    console.log(`  Type: ${verify[0].type}`);
    console.log(`  Removed: ${verify[0].removed}`);
  } else {
    console.error(`FAILED: ${imdbId} not found in library after adding.`);
    process.exit(1);
  }

  // 5. Clean up — remove test movie
  console.log(`\n--- Step 5: Clean up (remove ${imdbId}) ---`);
  await removeMovie(authKey, imdbId);

  console.log("\n=== ALL TESTS PASSED ===");
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "login":
      await login();
      break;

    case "get-library":
      await getLibrary(requireAuthKey());
      break;

    case "add-movie":
      if (!args[0]) {
        console.error("Usage: node scripts/test-stremio-api.js add-movie <imdbId>");
        process.exit(1);
      }
      await addMovie(requireAuthKey(), args[0]);
      break;

    case "remove-movie":
      if (!args[0]) {
        console.error("Usage: node scripts/test-stremio-api.js remove-movie <imdbId>");
        process.exit(1);
      }
      await removeMovie(requireAuthKey(), args[0]);
      break;

    case "full-test":
      await fullTest(args[0] || "tt0041959"); // default: The Third Man
      break;

    default:
      console.log("Stremio Library API Test\n");
      console.log("Commands:");
      console.log("  login                        — Authenticate, save authKey to .env");
      console.log("  get-library                  — List library items");
      console.log("  add-movie <imdbId>           — Add a movie to library");
      console.log("  remove-movie <imdbId>        — Remove a movie from library");
      console.log("  full-test [imdbId]           — Login → read → add → verify → cleanup");
      console.log("\nEnvironment variables (via .env or exported):");
      console.log("  STREMIO_EMAIL        — Stremio account email");
      console.log("  STREMIO_PASSWORD     — Stremio account password");
      console.log("  STREMIO_AUTH_KEY     — Auth key (set automatically after login)");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
