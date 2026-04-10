# Stremboxd Architecture Reference

**Source:** https://github.com/esp4ce/stremio-letterboxd-addon
**License:** MIT
**Purpose:** Document patterns and decisions from Stremboxd for future reference.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | Fastify 5 (TypeScript, ESM) |
| Frontend | Next.js + React + Tailwind CSS |
| Database | SQLite via `better-sqlite3` |
| Letterboxd | `@esp4ce/letterboxd-client` (private npm, wraps official API) |
| Validation | Zod (runtime schema validation on env, requests, configs) |
| Auth | JWT (jose) + AES-256-GCM encrypted refresh tokens |
| Logging | Pino (structured, child loggers per module) |
| Testing | Vitest + MSW (mock service worker) |
| Image Processing | Sharp (poster overlays) |

---

## Letterboxd API Access

Stremboxd has **official Letterboxd API credentials** (`CATALOG_CLIENT_ID` / `CATALOG_CLIENT_SECRET`). This is the single biggest differentiator — they can call `api.letterboxd.com/api/v0/` directly.

### Auth Flow (Full Mode)

```
User enters Letterboxd username + password
  → authenticateWithPassword(username, password, totp?)
  → POST api.letterboxd.com/api/v0/auth/token
  → Returns { access_token, refresh_token, expires_in: 3600 }
  → Refresh token encrypted (AES-256-GCM) and stored in SQLite
  → JWT issued to user for subsequent requests
  → Access token cached, auto-refreshes on 401
```

### Auth Flow (Public Mode)

```
App authenticates itself (Client Credentials grant)
  → authenticateAsApp()
  → Returns app-level access_token (read-only public data)
  → Cached with 60s pre-expiry refresh margin
```

### Hybrid Scraping Fallback

Even with API access, `letterboxd.service.ts` uses a two-strategy approach for resolving external lists:

1. **HTML scraping first** — `fetchPageHtml()` grabs the public list page, extracts the list ID from `<link rel="shortlink">` or `data-likeable-identifier` attributes
2. **API search fallback** — if scraping fails, queries the API to find lists by member + slug

The scraper uses plain `fetch()` with a configurable `CATALOG_USER_AGENT` — no headless browser.

---

## Three-Tier Access Model

| Tier | Auth Required | Features |
|------|--------------|----------|
| 1 (Public) | None | Popular This Week, Top 250 |
| 2 (Config) | Letterboxd username only (in URL) | Public watchlist, custom lists, liked films |
| 3 (Full) | Letterboxd login (password + optional 2FA) | Diary, friends activity, recommendations, rate/like/watched actions |

Tier is stored per-user in SQLite and auto-upgrades when a user authenticates.

---

## Caching Strategy

### Cache Implementation

- LRU caches via `lru-cache` with configurable `maxSize` and TTL
- Factory function: `createCache(name, options)` with config-sourced defaults
- Hit/miss metrics tracked per cache for monitoring

### Cache Tiers

| Cache | TTL | Max Size | Purpose |
|-------|-----|----------|---------|
| Film metadata | 1 hour | Default | Individual film lookups |
| Film ratings | 5 min | Default | Per-user film ratings |
| Public catalogs (Popular, Top 250) | 24 hours | Default | Shared across all users |
| User catalogs (watchlist, diary, etc.) | 5 min | Default | Per-user, per-catalog |
| Cinemeta lookups | 1 hour | Default | Stremio metadata enrichment |
| ID mappings (TMDB↔IMDb) | 1 hour | Default | Cross-service ID resolution |
| Poster images | N/A | 50 | Binary image data |

### Request Coalescing

The `Coalescer` class prevents thundering herd problems:

```typescript
class Coalescer {
  // Tracks in-flight promises by key
  // If request for key X is already in progress,
  // subsequent callers get the same promise instead of spawning duplicates
}
```

This is critical for a multi-user system where many users may request the same catalog simultaneously.

### Cache Invalidation

- User action (rate, like, watchlist toggle) → invalidates that user's relevant caches
- Per-user cache key tracking enables targeted invalidation without scanning
- Periodic pruning of stale user cache references
- Emergency purge function for memory pressure situations

---

## Concurrency Control

### TMDB API

```typescript
class Semaphore {
  constructor(private readonly max: number) {}
  acquire(): Promise<void> { /* ... */ }
  release(): void { /* ... */ }
}

// Global — TMDB rate limits are per API key, not per user
const semaphore = new Semaphore(MAX_CONCURRENT); // MAX_CONCURRENT = 10
```

Every TMDB request goes through the semaphore. On 429 (rate limit), exponential backoff with `retry-after` header support, up to `MAX_RETRIES = 2`.

### Letterboxd API

Token refresh is coalesced — if multiple requests hit an expired token simultaneously, only one refresh is issued.

### Cinemeta Enrichment

`enrichMetasWithCinemeta()` uses a two-phase approach:
1. **Synchronous pass** — apply any already-cached Cinemeta data
2. **Async pass** — fetch uncached entries concurrently (up to 10 at a time)

---

## Stremio Addon Structure

### Manifest

- ID: `community.stremboxd`
- Resources: `catalog`, `meta` (movie type only)
- `behaviorHints.configurable: false` / `configurationRequired: false`
- Manifest is generated dynamically per user, not static

### Manifest Generation

Four generators for different access levels:

| Function | Use Case |
|----------|----------|
| `generateBaseManifest()` | Minimal, unauthenticated |
| `generatePublicManifest()` | Config-encoded username, selective catalogs |
| `generateManifest()` | Authenticated user, full feature set |
| `generateDynamicManifest()` | Applies user preferences (reorder, rename, filter catalogs) |

### Config Encoding (Tier 2)

User preferences are base64url-encoded JSON embedded in the manifest URL:

```
/stremio/config/{base64url-encoded-json}/manifest.json
```

The JSON schema:
```typescript
{
  u: string,          // username
  c: {                // catalog toggles
    watchlist: boolean,
    popular: boolean,
    top250: boolean,
    likedFilms: boolean,
  },
  l: string[],        // list IDs
  r: boolean,         // show ratings
  n: Record<string, string>,  // custom catalog names
  w: string[],        // hidden catalogs
  o: string[],        // catalog order
  s: Record<string, string[]>, // sort variants per catalog
}
```

### Catalog Pagination

All catalogs return 100 items per page via `skip` parameter. Stremio's addon protocol handles this natively through the `extra` field.

### Sort & Filter

Catalogs support combined filters in a single dropdown:
- Sort orders: Recently Added, Your Rating, Popularity, Shuffle, etc.
- Genre filtering
- Decade-based filtering

Sort labels map to Letterboxd API parameters via `SORT_LABEL_TO_API`.

---

## ID Resolution

### The Chain

```
Letterboxd film → Letterboxd ID
  → resolveFilm() checks cache
  → Calls Letterboxd API with title/year or external ID
  → Extracts IMDb ID from film's external links
  → Falls back to Cinemeta search if needed
  → Caches mapping: TMDB ID ↔ IMDb ID
```

### Cinemeta (Stremio's Metadata Service)

Stremboxd uses Cinemeta as a secondary source for IMDb IDs and poster URLs. This is Stremio's own metadata addon that provides standardized film metadata.

---

## Security

| Concern | Solution |
|---------|----------|
| Refresh token storage | AES-256-GCM encryption at rest (64-char hex key) |
| User sessions | JWT with configurable TTL (default 7d) |
| API auth | Bearer token validation on protected routes |
| Rate limiting | `@fastify/rate-limit` middleware |
| Input validation | Zod schemas on all request bodies/params |
| Dashboard access | Separate password-protected admin area |

---

## Database Schema (Inferred)

```sql
-- Users table (from migrations and repository code)
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  letterboxd_id TEXT UNIQUE,
  letterboxd_username TEXT,
  letterboxd_display_name TEXT,
  refresh_token TEXT,          -- AES-256-GCM encrypted
  token_expires_at DATETIME,
  tier INTEGER DEFAULT 1,      -- 1=public, 2+=authenticated
  preferences TEXT,             -- JSON blob
  last_login DATETIME,
  created_at DATETIME,
  updated_at DATETIME
);
```

Later migrations added anonymous tracking and tier-1 user support.

---

## Key Takeaways for Our Project

1. **Plain HTTP scraping works** — even Stremboxd uses it as a fallback alongside API access
2. **LRU caching with short TTLs** — 5min for user-specific, 24hr for public, prevents hammering
3. **Request coalescing** — essential for multi-user scenarios to deduplicate concurrent requests
4. **Semaphore-based concurrency** — for external APIs with rate limits (TMDB, Letterboxd)
5. **Token management** — encrypt at rest, refresh proactively, coalesce refresh calls
6. **Config-in-URL pattern** — base64url-encoded JSON for stateless user config
7. **Cinemeta enrichment** — use Stremio's own metadata service for IMDb IDs and poster URLs
8. **SQLite is sufficient** — even a production addon with multiple users runs fine on SQLite
