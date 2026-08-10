// cloudflare-stats-worker V2 — dimensional analytics on Cloudflare Workers.
//
// D1 is the single source of truth (raw event fact table `events_tab`). The
// dashboard SPA is served from Workers Static Assets (env.ASSETS) at `/`.
//
//   POST /api/send     ingest one pageview (beacon)
//   GET  /api/query       grouped breakdown by any dimension
//   GET  /api/timeseries  daily trend
//   GET  /api/summary     headline cards (today / 7d / 30d / all-time)
//   GET  /api/config      { timezone } for client-side date math
//   GET  /api/realtime    WebSocket upgrade for the live (in-memory) dashboard
//   GET  /health          { status, version, timestamp }
//   *                     static assets (SPA)

import {
  getConfig,
  corsHeadersFor,
  resolveRequestOrigin,
  isAllowedOrigin,
  isDevOrigin,
  localDay,
  localDayOffset,
} from "./config.js";
import { isBot, parseUserAgent, parseReferrer } from "./ua.js";
import { RealtimeHub } from "./realtime.js";

export { RealtimeHub };

const WORKER_VERSION = "2.1.0";

// Cache lifetimes. A date range that ended before today can never change again,
// so it is cached for a day; anything touching today gets a short window.
// These are served to Workers Cache (see `[cache]` in wrangler.toml), which --
// unlike the Cache API -- does work on *.workers.dev.
const CACHE_TTL_CLOSED = 86400; // fully-past range: immutable
const CACHE_TTL_LIVE = 300; // range includes today
const CACHE_TTL_CONFIG = 3600; // /api/config: just the timezone
const CACHE_SWR = 3600; // serve stale this long while revalidating
// Workers Cache applies heuristic freshness to any response that does not say
// otherwise, so anything not meant to be cached has to opt out explicitly.
const NO_STORE = { "Cache-Control": "no-store" };
// Raw rows are pruned at 6 months, so a 366-day window only ever guarantees an
// expensive scan over days that no longer exist.
const MAX_QUERY_DAYS = 185;
const MAX_GROUP_BY_DIMS = 3; // hierarchy views ask for at most 3 levels at once
// Abuse bounds. Attacker-influenced values (dimension strings, filter tokens)
// must never grow unbounded — these cap per-request work and per-isolate memory.
const MAX_DIM_VALUE_LEN = 512; // clamp any single dimension string before it hits D1
const MAX_FILTERS = 20; // max include/exclude tokens honored per query (each is a DB lookup)
const MAX_DIM_CACHE_ENTRIES = 10000; // FIFO cap on the isolate-global dim-id cache

// --- Rollup bookkeeping (see schema.sql) ------------------------------------
// value_id/k* sentinel for "dimension absent". NOT NULL, because SQLite treats
// NULLs as distinct in a unique index: a NULL key would never match ON CONFLICT
// and would silently duplicate rows on every re-seal.
const NULL_VALUE_ID = 0;
const META_MIN_DAY = "rollup_min_day"; // earliest sealed day; before it -> raw
const META_MAX_DAY = "rollup_max_day"; // latest sealed day (normally yesterday)
const META_UV_SNAPSHOT = "uv_snapshot"; // JSON { as_of, uv } for the all-time card
// Sealed days are immutable, so the coverage bounds only move once a night.
// Caching them per isolate keeps the routing decision off the hot path.
const META_CACHE_MS = 60000;
// Nights it takes to seal the whole retention window: the cron walks backwards
// this many days per run. 3 days x 14 passes ~= 315K rows read, ~6% of budget.
const ROLLUP_BACKFILL_DAYS_PER_RUN = 3;
// Forward catch-up bound, for when nightly runs were missed. Keeps the sealed
// window contiguous without letting one run scan an unbounded backlog.
const MAX_SEAL_DAYS_PER_RUN = 7;
// The all-time UV snapshot is a full COUNT(DISTINCT) over events_tab (~27% of
// the daily read budget). It moves well under 1%/day, so it refreshes weekly --
// on Sundays, inside the existing nightly trigger rather than a new one (the
// free plan allows 5 cron triggers per account and all three deployments
// already use one each).
const UV_SNAPSHOT_WEEKDAY = 0;

// Drill-down hierarchies, stored as whole tuples in hier_daily_tab. Keys must
// match HIERARCHY in dashboard-v2/src/state/store.ts.
const HIERARCHIES = {
  browser: ["browser", "browser_version"],
  os: ["os", "os_version"],
  device: ["device_type", "device_vendor", "device_model"],
};

// Whitelist: dimension name -> { fact-table FK column, lookup table }.
// Both sides are trusted constants (never user input) so interpolating them
// into SQL is safe; all *values* are always bound parameters.
const DIMENSIONS = {
  path: { col: "path_id", table: "dim_path_tab" },
  referrer_domain: { col: "ref_domain_id", table: "dim_ref_domain_tab" },
  country: { col: "country_id", table: "dim_country_tab" },
  browser: { col: "browser_id", table: "dim_browser_tab" },
  browser_version: { col: "browser_ver_id", table: "dim_browser_ver_tab" },
  os: { col: "os_id", table: "dim_os_tab" },
  os_version: { col: "os_ver_id", table: "dim_os_ver_tab" },
  device_type: { col: "device_type_id", table: "dim_device_type_tab" },
  device_vendor: { col: "device_vendor_id", table: "dim_device_vendor_tab" },
  device_model: { col: "device_model_id", table: "dim_device_model_tab" },
};

// (PARENT_DIMS is gone: the `parent` column it produced existed so the client
// could stitch a hierarchy together from per-node queries. Multi-dimension
// group_by returns the whole tuple in `keys` instead.)

// Isolate-global dimension-id cache (value -> id). Dims are small and stable,
// so after warm-up the ingest path only runs the event INSERT.
const dimCache = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();
    const config = getConfig(env);

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeadersFor(request, config) });
    }

    // Static assets / SPA for everything that isn't an API route.
    if (!pathname.startsWith("/api/") && pathname !== "/health") {
      return serveAsset(request, env, url);
    }

    // No cache lookup here on purpose. `caches.default` is a no-op on
    // *.workers.dev — put() resolves, match() always misses — so the old
    // read-through block was dead code that cost an async hop per request.
    // Caching is now handled in front of the Worker by Workers Cache
    // (`[cache] enabled = true` in wrangler.toml), which does work on
    // workers.dev and keys on the full URL. Handlers drive it via the
    // Cache-Control they emit; see cacheHeaders().
    let response;
    try {
      switch (pathname) {
        case "/api/send":
          response = await handleCollect(request, env, ctx, config);
          break;
        case "/api/query":
          response = await handleQuery(request, env, config);
          break;
        case "/api/timeseries":
          response = await handleTimeseries(request, env, config);
          break;
        case "/api/summary":
          response = await handleSummary(request, env, config);
          break;
        case "/api/config":
          response = jsonResponse({ timezone: config.timezone }, 200, {
            "Cache-Control": `public, max-age=${CACHE_TTL_CONFIG}, stale-while-revalidate=${CACHE_SWR}`,
          });
          break;
        case "/api/realtime":
          response = await handleRealtime(request, env, config);
          break;
        case "/health":
          // Never cache: this is a liveness/version probe, and Workers Cache
          // applies heuristic freshness to any response that does not say
          // otherwise — which made /health report the previous deploy's version.
          response = jsonResponse({ status: "ok", version: WORKER_VERSION, timestamp: new Date().toISOString() }, 200, NO_STORE);
          break;
        default:
          response = jsonResponse({ error: "Not Found" }, 404, NO_STORE);
      }
    } catch (error) {
      console.error("[worker] error", error);
      // Only surface messages we set deliberately (they carry an explicit
      // .status). Unexpected failures (D1 driver text, internal invariants)
      // are masked so we don't leak internals to clients.
      const hasStatus = typeof error.status === "number";
      const status = hasStatus ? error.status : 500;
      const message = hasStatus ? error.message : "Internal Error";
      // no-store so a transient failure never gets cached in place of real data.
      response = jsonResponse({ error: message }, status, NO_STORE);
    }

    return response;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMaintenance(env));
  },
};

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

async function handleCollect(request, env, ctx, config) {
  if (request.method.toUpperCase() !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, 405);
  }

  const corsHeaders = corsHeadersFor(request, config);
  const origin = resolveRequestOrigin(request);
  if (!isAllowedOrigin(origin, config)) {
    return jsonResponse({ error: "Origin not allowed" }, 403, corsHeaders);
  }

  if (!config.recordLocalhost && isDevOrigin(origin)) {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Trust only CF-Connecting-IP: it is set by Cloudflare and cannot be spoofed.
  // (x-forwarded-for is client-supplied — using it would let attackers rotate
  // the rate-limit key and forge visitor identity.)
  const ip = (request.headers.get("CF-Connecting-IP") || "0.0.0.0").trim();
  await enforceRateLimit(env, ip);

  const userAgent = request.headers.get("User-Agent") || "";
  // Bot exclusion is unconditional — never record bot/crawler traffic.
  if (isBot(userAgent)) {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let payload = {};
  try {
    const text = await request.text();
    if (text) payload = JSON.parse(text);
  } catch {
    payload = {};
  }

  const path = normalizePath(payload.path || "/");
  const ua = parseUserAgent(userAgent);
  const ref = parseReferrer(payload.referrer || "", config.allowedOrigin);
  const country = request.cf?.country || "XX";
  const visitorId = await getVisitorId(ip, userAgent);
  const day = localDay(config.timezone);

  const db = getD1(env);
  if (db) {
    ctx.waitUntil(
      recordEvent(db, { day, visitorId, path, ref, country, ua }).catch((err) =>
        console.error("[worker] recordEvent error", err)
      )
    );
  }

  // Best-effort forward to the live-dashboard relay. Fully isolated from the
  // D1 write above: a missing binding, a cold/erroring Durable Object, or a
  // disconnected viewer must never affect ingest or D1 recording.
  const realtime = getRealtimeHub(env);
  if (realtime) {
    ctx.waitUntil(
      realtime
        .ingest({
          path,
          country,
          browser: ua.browser.name,
          browserVersion: ua.browser.version,
          os: ua.os.name,
          osVersion: ua.os.version,
          deviceType: ua.device.type,
          deviceVendor: ua.device.vendor,
          deviceModel: ua.device.model,
          referrerDomain: ref.domain,
          visitorId,
        })
        .catch((err) => console.error("[worker] realtime ingest error", err))
    );
  }

  return new Response(null, { status: 204, headers: corsHeaders });
}

// The live dashboard allows exactly one viewer, so every request routes to a
// single fixed Durable Object instance rather than one keyed per session.
function getRealtimeHub(env) {
  if (!env.REALTIME) return null;
  return env.REALTIME.get(env.REALTIME.idFromName("global"));
}

// WebSocket upgrade for the live dashboard. Unlike /api/send (which is called
// FROM the tracked website, so it's restricted to config.allowedOrigin), this
// is called from the dashboard SPA itself -- served by this same worker at
// its OWN domain, which is a different origin from the tracked website. The
// correct check is same-origin, not config.allowedOrigin.
async function handleRealtime(request, env, config) {
  const origin = resolveRequestOrigin(request);
  const selfOrigin = new URL(request.url).origin;
  if (origin !== selfOrigin && !isDevOrigin(origin)) {
    return jsonResponse({ error: "Origin not allowed" }, 403, NO_STORE);
  }
  const realtime = getRealtimeHub(env);
  if (!realtime) {
    return jsonResponse({ error: "Realtime is not configured" }, 503, NO_STORE);
  }
  return realtime.fetch(request);
}

async function recordEvent(db, e) {
  const [
    pathId,
    refDomainId,
    countryId,
    browserId,
    browserVerId,
    osId,
    osVerId,
    deviceTypeId,
    deviceVendorId,
    deviceModelId,
  ] = await Promise.all([
    getDimId(db, "dim_path_tab", e.path),
    getDimId(db, "dim_ref_domain_tab", e.ref.domain),
    getDimId(db, "dim_country_tab", e.country),
    getDimId(db, "dim_browser_tab", e.ua.browser.name),
    getDimId(db, "dim_browser_ver_tab", e.ua.browser.version),
    getDimId(db, "dim_os_tab", e.ua.os.name),
    getDimId(db, "dim_os_ver_tab", e.ua.os.version),
    getDimId(db, "dim_device_type_tab", e.ua.device.type),
    getDimId(db, "dim_device_vendor_tab", e.ua.device.vendor),
    getDimId(db, "dim_device_model_tab", e.ua.device.model),
  ]);

  await db
    .prepare(
      `INSERT INTO events_tab
        (day, visitor_id, path_id, ref_domain_id, country_id,
         browser_id, browser_ver_id, os_id, os_ver_id,
         device_type_id, device_vendor_id, device_model_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      e.day,
      e.visitorId,
      pathId,
      refDomainId,
      countryId,
      browserId,
      browserVerId,
      osId,
      osVerId,
      deviceTypeId,
      deviceVendorId,
      deviceModelId
    )
    .run();
}

// Get-or-create a dimension id. `table` is always a trusted constant.
// Uses upsert-returning so a single statement handles both insert and hit.
async function getDimId(db, table, value) {
  if (value === null || value === undefined || value === "") return null;
  // Clamp length so an attacker can't bloat dim tables / the cache with huge
  // strings. Must match lookupDimId so filters resolve to the stored value.
  const v = clampDimValue(value);
  const key = `${table}::${v}`;
  const cached = dimCache.get(key);
  if (cached !== undefined) return cached;

  // Read before write. The previous form was a single
  //   INSERT ... ON CONFLICT(value) DO UPDATE SET value=excluded.value RETURNING id
  // which is elegant but expensive in the wrong currency: on conflict it
  // REWRITES the row (and its unique index entry) to the value it already had,
  // so every isolate-cache miss cost ~2 rows written x 10 dimensions. Dimension
  // values are tiny, stable sets that almost always already exist, so that was
  // pure waste -- and it dominated the ingest write cost.
  //
  // D1's free tier gives 5M rows READ but only 100K rows WRITTEN per day,
  // account-wide, and exhausted writes mean dropped pageviews. Trading a write
  // for a read is therefore strongly favourable: the hit path below is now
  // read-only, and only a genuinely new value writes anything.
  let row = await db.prepare(`SELECT id FROM ${table} WHERE value = ?`).bind(v).first();
  if (!row) {
    // DO NOTHING (not DO UPDATE) so a concurrent insert of the same value does
    // not rewrite the row. It also returns no row when it loses that race,
    // which the re-read below resolves.
    row = await db
      .prepare(`INSERT INTO ${table}(value) VALUES(?) ON CONFLICT(value) DO NOTHING RETURNING id`)
      .bind(v)
      .first();
    if (!row) row = await db.prepare(`SELECT id FROM ${table} WHERE value = ?`).bind(v).first();
  }
  const id = row ? row.id : null;
  if (id !== null) {
    // FIFO cap: bound the isolate-global cache so unbounded distinct values
    // can't exhaust isolate memory.
    if (dimCache.size >= MAX_DIM_CACHE_ENTRIES) {
      dimCache.delete(dimCache.keys().next().value);
    }
    dimCache.set(key, id);
  }
  return id;
}

async function lookupDimId(db, table, value) {
  const row = await db.prepare(`SELECT id FROM ${table} WHERE value = ?`).bind(clampDimValue(value)).first();
  return row ? row.id : null;
}

function clampDimValue(value) {
  const s = `${value}`;
  return s.length > MAX_DIM_VALUE_LEN ? s.slice(0, MAX_DIM_VALUE_LEN) : s;
}

// ---------------------------------------------------------------------------
// Query API
// ---------------------------------------------------------------------------

async function handleQuery(request, env, config) {
  const db = requireD1(env);
  const url = new URL(request.url);

  const metric = url.searchParams.get("metric") === "visitors" ? "visitors" : "pageviews";
  const groupBy = (url.searchParams.get("group_by") || "path").split(",").map((s) => s.trim()).filter(Boolean);
  if (groupBy.length === 0 || groupBy.length > MAX_GROUP_BY_DIMS) {
    return jsonResponse({ error: `group_by must name 1-${MAX_GROUP_BY_DIMS} dimensions` }, 400, NO_STORE);
  }
  for (const name of groupBy) {
    if (!DIMENSIONS[name]) return jsonResponse({ error: `Unknown group_by: ${name}` }, 400, NO_STORE);
  }
  const { from, to } = resolveRange(url, config);
  // A tuple breakdown feeds a hierarchy the client truncates per ring, so it
  // needs far more rows than a flat top-N list. Both come from one statement,
  // and rows returned are not what costs -- rows scanned is.
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, groupBy.length > 1 ? 2000 : 200);

  const includes = parseFilterParam(url, "filter");
  const excludes = parseFilterParam(url, "exclude");

  const binds = [];
  let where = "";
  for (const f of includes) {
    const dim = DIMENSIONS[f.dimension];
    if (!dim) continue;
    const id = await lookupDimId(db, dim.table, f.value);
    if (id === null) {
      // Including a value that was never recorded -> no rows match.
      return queryResponse(metric, from, to, config, groupBy, [], 0);
    }
    where += ` AND e.${dim.col} = ?`;
    binds.push(id);
  }
  for (const f of excludes) {
    const dim = DIMENSIONS[f.dimension];
    if (!dim) continue;
    const id = await lookupDimId(db, dim.table, f.value);
    if (id === null) continue;
    where += ` AND (e.${dim.col} IS NULL OR e.${dim.col} <> ?)`;
    binds.push(id);
  }

  const plan = await planQuery(db, config, { metric, groupBy, from, to, filtered: binds.length > 0 });
  const { rows, total } = plan.rollup
    ? await queryViaRollup(db, plan, limit)
    : await queryViaRaw(db, plan, where, binds, limit);

  return queryResponse(metric, from, to, config, groupBy, rows, total);
}

// Decide where a query is answered from, and split the range accordingly.
//
// Rollup-eligible queries read sealed days from dim_daily_tab/hier_daily_tab and
// UNION today's live rows from events_tab in the SAME statement, so "today" is
// never stale. Everything else scans events_tab exactly as it always has.
//
// Not eligible:
//   * any include/exclude filter -- the rollups hold no cross-dimension tuples
//   * metric=visitors -- the rollups store PV only, precisely so that no code
//                        path can silently sum COUNT(DISTINCT) across days (or,
//                        for a partial hierarchy, across its deeper levels).
//                        Unique visitors are always exact, via events_tab.
//   * a range starting before the sealed window -- partial data would silently
//                        under-report, so fall back rather than lie
async function planQuery(db, config, { metric, groupBy, from, to, filtered }) {
  const today = localDay(config.timezone);
  const base = { metric, groupBy, from, to, today, rollup: false };
  if (filtered || metric === "visitors") return base;

  const hier = groupBy.length > 1 ? hierarchyFor(groupBy) : null;
  if (groupBy.length > 1 && !hier) return base; // ad-hoc tuple: raw only

  const meta = await readMeta(db);
  const minDay = Number(meta[META_MIN_DAY] ?? 0);
  const maxDay = Number(meta[META_MAX_DAY] ?? 0);
  if (!minDay || from < minDay) return base;

  // Sealed portion of the range, plus whichever trailing days are not sealed yet
  // (normally just today; more if a nightly run was missed).
  const sealedTo = Math.min(to, maxDay);
  const liveFrom = offsetDayInt(sealedTo, 1);
  if (sealedTo < from) return base; // nothing sealed in range -> plain raw scan
  return { ...base, rollup: true, hier, sealedFrom: from, sealedTo, liveFrom, liveTo: to };
}

function hierarchyFor(groupBy) {
  for (const [name, levels] of Object.entries(HIERARCHIES)) {
    if (levels.length >= groupBy.length && groupBy.every((d, i) => levels[i] === d)) {
      return { name, depth: groupBy.length };
    }
  }
  return null;
}

// Rollup path. One statement: sealed rows from the rollup table UNION ALL live
// rows for any not-yet-sealed day, aggregated together, with the grand total
// carried as a window function so it survives LIMIT without a second scan.
async function queryViaRollup(db, plan, limit) {
  const { groupBy, hier, sealedFrom, sealedTo, liveFrom, liveTo } = plan;
  const cols = groupBy.map((d) => DIMENSIONS[d].col);
  const keyCount = cols.length;
  const keyNames = cols.map((_, i) => `k${i}`);
  const binds = [];

  let sealed;
  if (hier) {
    // A partial hierarchy (e.g. device_type+device_vendor out of three levels)
    // selects only the leading keys; the outer GROUP BY sums the rest away.
    // Safe because pv is additive -- which is why this table stores no uv.
    sealed =
      `SELECT ${keyNames.join(", ")}, pv AS n FROM hier_daily_tab ` +
      `WHERE hier = ? AND day BETWEEN ? AND ?`;
    binds.push(hier.name, sealedFrom, sealedTo);
  } else {
    sealed = `SELECT value_id AS k0, pv AS n FROM dim_daily_tab WHERE dimension = ? AND day BETWEEN ? AND ?`;
    binds.push(groupBy[0], sealedFrom, sealedTo);
  }

  let live = "";
  if (liveFrom <= liveTo) {
    const sel = cols.map((c, i) => `COALESCE(e.${c}, ${NULL_VALUE_ID}) AS k${i}`).join(", ");
    const grp = cols.map((c) => `e.${c}`).join(", ");
    live =
      ` UNION ALL SELECT ${sel}, COUNT(*) AS n FROM events_tab e ` +
      `WHERE e.day BETWEEN ? AND ? GROUP BY ${grp}`;
    binds.push(liveFrom, liveTo);
  }

  const keyList = keyNames.join(", ");
  const sql =
    `WITH agg AS (${sealed}${live}) ` +
    `SELECT ${keyList}, SUM(n) AS value, SUM(SUM(n)) OVER () AS total ` +
    `FROM agg GROUP BY ${keyList} ORDER BY value DESC LIMIT ?`;
  binds.push(limit);

  const { results } = await db.prepare(sql).bind(...binds).all();
  if (results.length === 0) return { rows: [], total: 0 };

  // Resolve ids -> labels only for the rows actually returned: at most `limit`
  // primary-key lookups, versus joining across the whole pre-LIMIT aggregate.
  const labels = await resolveLabels(db, groupBy, results, keyCount);
  const rows = results.map((r) => ({
    keys: groupBy.map((d, i) => labels[i].get(Number(r[`k${i}`])) ?? nullLabelFor(d)),
    value: Number(r.value),
  }));
  return { rows, total: Number(results[0].total) };
}

// Raw path — unchanged semantics, extended to group by up to 3 dimensions in a
// single statement. Replaces the sunburst's per-node fan-out (which issued up to
// 261 requests / 522 range scans for one click) with one scan.
async function queryViaRaw(db, plan, where, binds, limit) {
  const { groupBy, from, to, metric } = plan;
  const cols = groupBy.map((d) => DIMENSIONS[d].col);
  const sel = cols.map((c, i) => `COALESCE(e.${c}, ${NULL_VALUE_ID}) AS k${i}`).join(", ");
  const grp = cols.map((c) => `e.${c}`).join(", ");
  const agg = metric === "visitors" ? "COUNT(DISTINCT e.visitor_id)" : "COUNT(*)";

  // COUNT(DISTINCT) is not summable, so visitors still needs its own total
  // statement. COUNT(*) rides along as a window function for free.
  const totalExpr = metric === "visitors" ? "" : ", SUM(COUNT(*)) OVER () AS total";
  const sql =
    `SELECT ${sel}, ${agg} AS value${totalExpr} FROM events_tab e ` +
    `WHERE e.day BETWEEN ? AND ?${where} GROUP BY ${grp} ORDER BY value DESC LIMIT ?`;
  const { results } = await db.prepare(sql).bind(from, to, ...binds, limit).all();

  let total = 0;
  if (metric === "visitors") {
    const row = await db
      .prepare(`SELECT COUNT(DISTINCT e.visitor_id) AS value FROM events_tab e WHERE e.day BETWEEN ? AND ?${where}`)
      .bind(from, to, ...binds)
      .first();
    total = row ? Number(row.value) : 0;
  } else if (results.length > 0) {
    total = Number(results[0].total);
  }

  if (results.length === 0) return { rows: [], total };
  const labels = await resolveLabels(db, groupBy, results, cols.length);
  const rows = results.map((r) => ({
    keys: groupBy.map((d, i) => labels[i].get(Number(r[`k${i}`])) ?? nullLabelFor(d)),
    value: Number(r.value),
  }));
  return { rows, total };
}

// One `WHERE id IN (...)` per grouped dimension, over the returned rows only.
//
// The ids are interpolated rather than bound: D1 allows at most 100 bound
// parameters per statement, and a tuple query can legitimately return thousands
// of distinct ids. This is safe because every id is round-tripped through
// Number() and rejected unless it is a finite integer — these values come from
// our own primary keys, never from the request.
async function resolveLabels(db, groupBy, results, keyCount) {
  const maps = [];
  const lookups = [];
  for (let i = 0; i < keyCount; i += 1) {
    const ids = [
      ...new Set(
        results
          .map((r) => Number(r[`k${i}`]))
          .filter((n) => Number.isInteger(n) && n !== NULL_VALUE_ID)
      ),
    ];
    const map = new Map();
    maps.push(map);
    if (ids.length === 0) continue;
    const table = DIMENSIONS[groupBy[i]].table;
    lookups.push(
      db
        .prepare(`SELECT id, value FROM ${table} WHERE id IN (${ids.join(",")})`)
        .all()
        .then(({ results: rows }) => {
          for (const row of rows) map.set(Number(row.id), row.value);
        })
    );
  }
  await Promise.all(lookups);
  return maps;
}

function nullLabelFor(dimension) {
  return dimension.startsWith("referrer") ? "(direct)" : "(unknown)";
}

function queryResponse(metric, from, to, config, groupBy, rows, total) {
  const envelope = {
    metric,
    range: { from: dayIntToISO(from), to: dayIntToISO(to), timezone: config.timezone },
    group_by: groupBy.length === 1 ? groupBy[0] : groupBy,
    // Single-dimension results keep the historical { key, value } shape;
    // multi-dimension results carry the whole tuple.
    results: rows.map((r) => (groupBy.length === 1 ? { key: r.keys[0], value: r.value } : { keys: r.keys, value: r.value })),
    total,
  };
  if (metric === "visitors") {
    envelope.note = "total is distinct visitors over the filtered set; it is not the sum of per-group values (UV is not additive).";
  }
  return jsonResponse(envelope, 200, cacheHeaders(to, config));
}

async function handleTimeseries(request, env, config) {
  const db = requireD1(env);
  const url = new URL(request.url);
  const metric = url.searchParams.get("metric") === "visitors" ? "visitors" : "pageviews";
  const { from, to } = resolveRange(url, config);

  const includes = parseFilterParam(url, "filter");
  const excludes = parseFilterParam(url, "exclude");

  const binds = [from, to];
  let where = "e.day BETWEEN ? AND ?";
  for (const f of includes) {
    const dim = DIMENSIONS[f.dimension];
    if (!dim) continue;
    const id = await lookupDimId(db, dim.table, f.value);
    if (id === null) return jsonResponse(seriesEnvelope(from, to, metric, new Map()), 200, cacheHeaders(to, config));
    where += ` AND e.${dim.col} = ?`;
    binds.push(id);
  }
  for (const f of excludes) {
    const dim = DIMENSIONS[f.dimension];
    if (!dim) continue;
    const id = await lookupDimId(db, dim.table, f.value);
    if (id === null) continue;
    where += ` AND (e.${dim.col} IS NULL OR e.${dim.col} <> ?)`;
    binds.push(id);
  }
  const filtered = binds.length > 2;

  // Unfiltered trend is exactly what site_daily_tab stores, one row per day.
  // Per-day UV is safe to read straight out of it: the chart plots each day
  // independently and never sums unique visitors across days.
  const column = metric === "visitors" ? "uv" : "pv";
  const liveAgg = metric === "visitors" ? "COUNT(DISTINCT e.visitor_id)" : "COUNT(*)";
  let results;
  if (!filtered) {
    const meta = await readMeta(db);
    const minDay = Number(meta[META_MIN_DAY] ?? 0);
    const sealedTo = Math.min(to, Number(meta[META_MAX_DAY] ?? 0));
    if (minDay && from >= minDay && sealedTo >= from) {
      const parts = [`SELECT day, ${column} AS value FROM site_daily_tab WHERE day BETWEEN ? AND ?`];
      const args = [from, sealedTo];
      const liveFrom = offsetDayInt(sealedTo, 1);
      if (liveFrom <= to) {
        parts.push(`SELECT e.day AS day, ${liveAgg} AS value FROM events_tab e WHERE e.day BETWEEN ? AND ? GROUP BY e.day`);
        args.push(liveFrom, to);
      }
      ({ results } = await db.prepare(parts.join(" UNION ALL ")).bind(...args).all());
    }
  }
  if (!results) {
    ({ results } = await db
      .prepare(`SELECT e.day AS day, ${liveAgg} AS value FROM events_tab e WHERE ${where} GROUP BY e.day`)
      .bind(...binds)
      .all());
  }

  const byDay = new Map(results.map((r) => [Number(r.day), Number(r.value)]));
  return jsonResponse(seriesEnvelope(from, to, metric, byDay), 200, cacheHeaders(to, config));
}

function seriesEnvelope(from, to, metric, byDay) {
  const results = [];
  for (const day of eachDay(from, to)) {
    results.push({ date: dayIntToISO(day), value: byDay.get(day) || 0 });
  }
  return { metric, interval: "day", results };
}

// Headline cards.
//
// PV is live and exact on every card: it is additive, so sealed days come from
// site_daily_tab (<=180 rows) and today is counted straight off events_tab.
//
// UV is not additive, so window figures cannot be assembled the same way. Only
// today's UV is computed live (a single day's rows); 7d / 30d / all-time come
// from the snapshot the cron writes, and the response carries `uv_as_of` so the
// dashboard can label them. This is the whole point of the rewrite: the old
// version ran an unbounded COUNT(DISTINCT visitor_id) over events_tab on every
// cold load, ~1.35M rows, which alone was a quarter of the daily budget.
async function handleSummary(request, env, config) {
  const db = requireD1(env);
  const today = localDay(config.timezone);
  const d7 = localDayOffset(config.timezone, 6);
  const d30 = localDayOffset(config.timezone, 29);

  const meta = await readMeta(db);
  const yesterday = offsetDayInt(today, -1);
  // Days already rolled into site_daily_tab, and the tail that is not yet.
  // Normally the tail is empty and only `today` is live; it grows only if a
  // nightly run was missed.
  const sealedTo = Math.min(yesterday, Number(meta[META_MAX_DAY] ?? 0));
  // Deliberately NOT clamped to the 30-day window: the all-time card sums this
  // too, so clamping would understate it. With a sealed window this is one day
  // or none; before the first backfill it degrades to a full per-day scan --
  // exactly the old cost, and correct, rather than cheap and wrong.
  const unsealedFrom = sealedTo > 0 ? offsetDayInt(sealedTo, 1) : 0;

  const sealedPv = (a, b) =>
    b < a
      ? Promise.resolve(null)
      : db.prepare("SELECT COALESCE(SUM(pv),0) AS pv FROM site_daily_tab WHERE day BETWEEN ? AND ?").bind(a, b).first();

  const [todayRow, unsealed, sealed7, sealed30, sealedAll, archRow] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv FROM events_tab WHERE day = ?").bind(today).first(),
    // Per-day PV for the unsealed tail, so each window can take its own slice.
    unsealedFrom > yesterday
      ? Promise.resolve({ results: [] })
      : db
          .prepare("SELECT day, COUNT(*) AS pv FROM events_tab WHERE day BETWEEN ? AND ? GROUP BY day")
          .bind(unsealedFrom, yesterday)
          .all(),
    sealedPv(d7, sealedTo),
    sealedPv(d30, sealedTo),
    sealedPv(0, sealedTo),
    db.prepare("SELECT COALESCE(SUM(pv),0) AS pv FROM events_monthly_tab WHERE dimension = 'total'").first(),
  ]);

  const pvOf = (row) => (row ? Number(row.pv) : 0);
  const todayPv = pvOf(todayRow);
  // PV for one window = sealed days + unsealed tail within the window + today.
  const windowPv = (sealedRow, from) =>
    pvOf(sealedRow) +
    unsealed.results.reduce((sum, r) => (Number(r.day) >= from ? sum + Number(r.pv) : sum), 0) +
    todayPv;

  const snapshot = parseJson(meta[META_UV_SNAPSHOT]) || {};

  return jsonResponse(
    {
      timezone: config.timezone,
      today: { pv: todayPv, uv: todayRow ? Number(todayRow.uv) : 0 },
      last7d: { pv: windowPv(sealed7, d7), uv: snapshot.last7d ?? null },
      last30d: { pv: windowPv(sealed30, d30), uv: snapshot.last30d ?? null },
      // all-time PV includes pruned months; all-time UV is hot-window only (UV not additive across archives).
      allTime: {
        pv: windowPv(sealedAll, 0) + pvOf(archRow),
        uv: snapshot.allTime ?? null,
        uv_note: "distinct visitors within the retained ~6-month window",
      },
      // today.uv is live; every other uv is as of this day. null until the first
      // nightly run writes a snapshot.
      uv_as_of: snapshot.as_of ? dayIntToISO(snapshot.as_of) : null,
    },
    200,
    cacheHeaders(today, config)
  );
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scheduled maintenance: refresh daily rollup, archive + prune > 6 months
// ---------------------------------------------------------------------------

async function runMaintenance(env) {
  const db = getD1(env);
  if (!db) return;
  const config = getConfig(env);
  const tz = config.timezone;
  const today = localDay(tz);
  const yesterday = offsetDayInt(today, -1);

  // 1) Seal every closed day up to yesterday that is not sealed yet.
  //
  //    Always re-seal at least the last two days: ingest writes are
  //    fire-and-forget (ctx.waitUntil), so a few of yesterday's events can land
  //    after the previous run.
  //
  //    Crucially the sealed window must stay CONTIGUOUS. If a run is missed,
  //    resuming at today-2 would advance rollup_max_day past days that were
  //    never sealed, and queries covering them would silently under-report.
  //    Instead we resume from the last sealed day, capped so one catch-up run
  //    cannot itself blow the read budget; the next night continues.
  const meta = await readMeta(db);
  const lastSealed = Number(meta[META_MAX_DAY] ?? 0);
  const resumeFrom = lastSealed ? offsetDayInt(lastSealed, 1) : offsetDayInt(today, -2);
  const sealFrom = Math.min(resumeFrom, offsetDayInt(today, -2));
  const sealTo = Math.min(yesterday, offsetDayInt(sealFrom, MAX_SEAL_DAYS_PER_RUN - 1));
  await sealDays(db, sealFrom, sealTo);
  metaCache = { at: 0, value: null };

  // 2) Walk the sealed window backwards a few days per night until it covers the
  //    whole retention window. Everything below rollup_min_day still answers
  //    correctly, just via a raw scan, so this is a pure speed-up over time.
  await extendRollupHistory(db);

  // 3) Refresh the unique-visitor snapshot the headline cards read.
  await refreshUvSnapshot(db, tz, today);

  // 4) Archive + prune raw events older than 6 whole months.
  let cy = Math.floor(today / 10000);
  let cm = Math.floor((today % 10000) / 100) - 6;
  while (cm <= 0) {
    cm += 12;
    cy -= 1;
  }
  const cutoffDay = (cy * 100 + cm) * 100; // days strictly < this are archived

  // Ask for the OLDEST remaining day below the cutoff, one month at a time.
  // The previous form -- SELECT DISTINCT (day / 100) WHERE (day / 100) < ? --
  // wrapped the indexed column in an expression, so idx_events_day could not be
  // used and it full-scanned events_tab (~1.35M rows) every single night even
  // when there was nothing to archive. This is an index min lookup.
  for (;;) {
    const row = await db.prepare("SELECT MIN(day) AS day FROM events_tab WHERE day < ?").bind(cutoffDay).first();
    if (!row || row.day === null) break;
    await archiveMonth(db, Math.floor(Number(row.day) / 100));
  }
}

// Recompute the rollups for [from, to] from scratch. Idempotent: every write is
// an upsert keyed on the natural key, so a day is replaced rather than added to.
// Bounds are written last so a reader can never see a coverage claim for rows
// that have not landed yet.
async function sealDays(db, from, to) {
  if (from > to) return;
  const statements = [];

  for (const [dimension, dim] of Object.entries(DIMENSIONS)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO dim_daily_tab (dimension, day, value_id, pv)
           SELECT ?, day, COALESCE(${dim.col}, ${NULL_VALUE_ID}), COUNT(*) FROM events_tab
           WHERE day BETWEEN ? AND ? GROUP BY day, ${dim.col}
           ON CONFLICT(dimension, day, value_id) DO UPDATE SET pv = excluded.pv`
        )
        .bind(dimension, from, to)
    );
  }

  for (const [hier, levels] of Object.entries(HIERARCHIES)) {
    const cols = levels.map((d) => DIMENSIONS[d].col);
    const keys = [0, 1, 2].map((i) => (cols[i] ? `COALESCE(${cols[i]}, ${NULL_VALUE_ID})` : String(NULL_VALUE_ID)));
    statements.push(
      db
        .prepare(
          `INSERT INTO hier_daily_tab (hier, day, k0, k1, k2, pv)
           SELECT ?, day, ${keys.join(", ")}, COUNT(*) FROM events_tab
           WHERE day BETWEEN ? AND ? GROUP BY day, ${cols.join(", ")}
           ON CONFLICT(hier, day, k0, k1, k2) DO UPDATE SET pv = excluded.pv`
        )
        .bind(hier, from, to)
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO site_daily_tab (day, pv, uv)
         SELECT day, COUNT(*), COUNT(DISTINCT visitor_id) FROM events_tab
         WHERE day BETWEEN ? AND ? GROUP BY day
         ON CONFLICT(day) DO UPDATE SET pv = excluded.pv, uv = excluded.uv`
      )
      .bind(from, to)
  );

  statements.push(
    db
      .prepare(
        `INSERT INTO meta_tab (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = CASE
           WHEN CAST(excluded.value AS INTEGER) > CAST(meta_tab.value AS INTEGER) THEN excluded.value
           ELSE meta_tab.value END`
      )
      .bind(META_MAX_DAY, String(to))
  );
  statements.push(
    db
      .prepare(
        `INSERT INTO meta_tab (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = CASE
           WHEN CAST(excluded.value AS INTEGER) < CAST(meta_tab.value AS INTEGER) THEN excluded.value
           ELSE meta_tab.value END`
      )
      .bind(META_MIN_DAY, String(from))
  );

  await db.batch(statements);
}

// Extend coverage backwards, bounded per run so the nightly job never becomes
// the thing that blows the read budget.
async function extendRollupHistory(db) {
  const meta = await readMeta(db);
  const minDay = Number(meta[META_MIN_DAY] ?? 0);
  if (!minDay) return; // nothing sealed yet -> run migrations/backfill-rollups.sql
  const oldest = await db.prepare("SELECT MIN(day) AS day FROM events_tab").first();
  if (!oldest || oldest.day === null) return;
  if (Number(oldest.day) >= minDay) return; // already covers everything retained

  const to = offsetDayInt(minDay, -1);
  const from = Math.max(Number(oldest.day), offsetDayInt(to, -(ROLLUP_BACKFILL_DAYS_PER_RUN - 1)));
  await sealDays(db, from, to);
  metaCache = { at: 0, value: null };
}

// Unique-visitor figures for the headline cards.
//
// 7d/30d refresh nightly (~280K rows). All-time is a full COUNT(DISTINCT) over
// events_tab -- ~1.35M rows, over a quarter of the daily budget -- so it
// refreshes weekly and rides inside this same trigger. The free plan allows 5
// cron triggers per account and the three deployments already use one each, so
// a second schedule is not available even if we wanted one.
async function refreshUvSnapshot(db, tz, today) {
  const meta = await readMeta(db);
  const previous = parseJson(meta[META_UV_SNAPSHOT]) || {};
  const uvFor = async (from) => {
    const row = await db
      .prepare("SELECT COUNT(DISTINCT visitor_id) AS uv FROM events_tab WHERE day BETWEEN ? AND ?")
      .bind(from, today)
      .first();
    return row ? Number(row.uv) : 0;
  };

  const snapshot = {
    as_of: today,
    last7d: await uvFor(localDayOffset(tz, 6)),
    last30d: await uvFor(localDayOffset(tz, 29)),
    allTime: previous.allTime ?? null,
  };

  const isWeekly = new Date().getUTCDay() === UV_SNAPSHOT_WEEKDAY;
  if (isWeekly || snapshot.allTime === null) {
    const row = await db.prepare("SELECT COUNT(DISTINCT visitor_id) AS uv FROM events_tab").first();
    snapshot.allTime = row ? Number(row.uv) : 0;
    snapshot.all_time_as_of = today;
  } else {
    snapshot.all_time_as_of = previous.all_time_as_of ?? null;
  }

  await db
    .prepare("INSERT INTO meta_tab (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(META_UV_SNAPSHOT, JSON.stringify(snapshot))
    .run();
  metaCache = { at: 0, value: null };
}

// yyyymm -> the yyyymmdd of the 1st of the following month.
function firstDayOfNextMonth(month) {
  const y = Math.floor(month / 100);
  const m = month % 100;
  return (m === 12 ? (y + 1) * 100 + 1 : month + 1) * 100 + 1;
}

async function archiveMonth(db, month) {
  const start = month * 100 + 1;
  const end = month * 100 + 31;

  const statements = [
    db
      .prepare(
        `INSERT INTO events_monthly_tab (month, dimension, value, pv, uv)
         SELECT ?, 'total', '', COUNT(*), COUNT(DISTINCT visitor_id) FROM events_tab WHERE day BETWEEN ? AND ?
         ON CONFLICT(month, dimension, value) DO UPDATE SET pv = excluded.pv, uv = excluded.uv`
      )
      .bind(month, start, end),
  ];

  for (const [dimension, dim] of Object.entries(DIMENSIONS)) {
    statements.push(
      db
        .prepare(
          // LEFT JOIN, not JOIN: an inner join silently dropped every row whose
          // dimension FK was NULL — all direct traffic, for one — so the
          // archived per-dimension PV did not add up to the 'total' row.
          `INSERT INTO events_monthly_tab (month, dimension, value, pv, uv)
           SELECT ?, ?, COALESCE(d.value, ?), COUNT(*), COUNT(DISTINCT e.visitor_id)
           FROM events_tab e LEFT JOIN ${dim.table} d ON d.id = e.${dim.col}
           WHERE e.day BETWEEN ? AND ? GROUP BY e.${dim.col}
           ON CONFLICT(month, dimension, value) DO UPDATE SET pv = excluded.pv, uv = excluded.uv`
        )
        .bind(month, dimension, nullLabelFor(dimension), start, end)
    );
  }

  await db.batch(statements);

  // Drop the raw rows and every rollup row for the archived month. The rollups
  // must not outlive the raw data they summarise: events_monthly_tab now owns
  // this month's totals, and leaving site_daily_tab rows behind would make the
  // all-time PV card count the month twice.
  await db.batch([
    db.prepare("DELETE FROM events_tab WHERE day BETWEEN ? AND ?").bind(start, end),
    db.prepare("DELETE FROM site_daily_tab WHERE day BETWEEN ? AND ?").bind(start, end),
    db.prepare("DELETE FROM dim_daily_tab WHERE day BETWEEN ? AND ?").bind(start, end),
    db.prepare("DELETE FROM hier_daily_tab WHERE day BETWEEN ? AND ?").bind(start, end),
    db
      .prepare(
        `INSERT INTO meta_tab (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = CASE
           WHEN CAST(excluded.value AS INTEGER) > CAST(meta_tab.value AS INTEGER) THEN excluded.value
           ELSE meta_tab.value END`
      )
      .bind(META_MIN_DAY, String(firstDayOfNextMonth(month))),
  ]);
  metaCache = { at: 0, value: null };
  console.log(`[worker] archived + pruned month ${month}`);
}

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

async function serveAsset(request, env, url) {
  if (!env.ASSETS) {
    return new Response("Dashboard not built. Run: pnpm --dir dashboard-v2 build", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  let res = await env.ASSETS.fetch(request);
  if (res.status === 404) {
    // SPA fallback for client-side routes.
    res = await env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
  }
  const headers = new Headers(res.headers);
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'self'; frame-ancestors 'none'"
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return new Response(res.body, { status: res.status, headers });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getD1(env) {
  return env.DB || env.cloudflare_stats_db || null;
}

function requireD1(env) {
  const db = getD1(env);
  if (!db) {
    const error = new Error("D1 database is not bound");
    error.status = 503;
    throw error;
  }
  return db;
}

// Per-IP ingest cap via the Workers Rate Limiting binding (RATE_LIMITER).
// Atomic and edge-enforced (per-colo), unlike the old KV get-then-put which
// was non-atomic and bypassable under bursts. The limit/period live in
// wrangler.toml. Absent binding (e.g. tests) -> no limiting.
async function enforceRateLimit(env, ip) {
  const limiter = env.RATE_LIMITER;
  if (!limiter) return;
  const { success } = await limiter.limit({ key: ip });
  if (!success) {
    const error = new Error("Rate limit exceeded");
    error.status = 429;
    throw error;
  }
}

async function getVisitorId(ip, userAgent) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${userAgent}`));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 7; i += 1) hex += bytes[i].toString(16).padStart(2, "0");
  return parseInt(hex.slice(0, 13), 16); // 52-bit int, safe for JS Number
}

function parseFilterParam(url, name) {
  const out = [];
  for (const raw of url.searchParams.getAll(name)) {
    for (const token of raw.split(",")) {
      // Cap honored tokens: each filter is a sequential D1 lookup, so an
      // unbounded list would amplify one request into many DB round-trips.
      if (out.length >= MAX_FILTERS) return out;
      const t = token.trim();
      if (!t) continue;
      const idx = t.indexOf(":");
      if (idx <= 0) continue;
      out.push({ dimension: t.slice(0, idx), value: t.slice(idx + 1) });
    }
  }
  return out;
}

function resolveRange(url, config) {
  const toParam = parseDayParam(url.searchParams.get("to"));
  const fromParam = parseDayParam(url.searchParams.get("from"));
  const to = toParam ?? localDay(config.timezone);
  let from = fromParam ?? localDayOffset(config.timezone, 6);
  if (from > to) from = to;
  // Cap the span to protect D1 from pathological full-history distinct scans.
  const cappedFrom = eachDaySpan(from, to) > MAX_QUERY_DAYS ? offsetDayInt(to, -(MAX_QUERY_DAYS - 1)) : from;
  return { from: cappedFrom, to };
}

function parseDayParam(value) {
  if (!value) return null;
  const digits = value.replaceAll("-", "");
  if (!/^\d{8}$/.test(digits)) return null;
  return Number(digits);
}

function clampInt(value, def, min, max) {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

// yyyymmdd int -> "YYYY-MM-DD"
function dayIntToISO(day) {
  const s = String(day);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// Iterate yyyymmdd ints inclusively from `from` to `to` (calendar-correct).
function* eachDay(from, to) {
  let y = Math.floor(from / 10000);
  let m = Math.floor((from % 10000) / 100);
  let d = from % 100;
  const cur = new Date(Date.UTC(y, m - 1, d));
  while (true) {
    const day = cur.getUTCFullYear() * 10000 + (cur.getUTCMonth() + 1) * 100 + cur.getUTCDate();
    if (day > to) break;
    yield day;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

function eachDaySpan(from, to) {
  const a = Date.UTC(Math.floor(from / 10000), (Math.floor((from % 10000) / 100)) - 1, from % 100);
  const b = Date.UTC(Math.floor(to / 10000), (Math.floor((to % 10000) / 100)) - 1, to % 100);
  return Math.round((b - a) / 86400000) + 1;
}

function offsetDayInt(day, deltaDays) {
  const base = new Date(Date.UTC(Math.floor(day / 10000), Math.floor((day % 10000) / 100) - 1, day % 100));
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return base.getUTCFullYear() * 10000 + (base.getUTCMonth() + 1) * 100 + base.getUTCDate();
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

// A range that ended before today can never change again, so it is cached for a
// day; anything touching today gets a short window. `stale-while-revalidate`
// lets Workers Cache serve the previous answer instantly and refresh behind it,
// which is why `s-maxage` is deliberately not used (it disables SWR).
function cacheHeaders(to, config) {
  const ttl = to < localDay(config.timezone) ? CACHE_TTL_CLOSED : CACHE_TTL_LIVE;
  return { "Cache-Control": `public, max-age=${ttl}, stale-while-revalidate=${CACHE_SWR}` };
}

// meta_tab is 3 rows and its values only move once a night, so this keeps the
// rollup routing decision off the hot path. A stale read is always an OLDER
// (smaller) rollup_max_day, which can only push days onto the live path -- it
// can never make a query skip a day that is not actually sealed yet.
let metaCache = { at: 0, value: null };

async function readMeta(db) {
  const now = Date.now();
  if (metaCache.value && now - metaCache.at < META_CACHE_MS) return metaCache.value;
  const out = {};
  try {
    const { results } = await db.prepare("SELECT key, value FROM meta_tab").all();
    for (const row of results) out[row.key] = row.value;
  } catch {
    // meta_tab absent (deployment predates the rollup migration) -> no coverage,
    // so every query takes the raw path and stays correct.
  }
  metaCache = { at: now, value: out };
  return out;
}

// Path normalization: full URLs -> pathname; strip query/hash, index files,
// language prefixes; enforce a single leading + trailing slash.
function normalizePath(input) {
  if (!input) return "/";
  let raw = `${input}`.trim();
  if (!raw) return "/";
  if (raw.startsWith("//")) raw = `https:${raw}`;

  let pathSource = raw;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      pathSource = new URL(raw).pathname || "/";
    } else if (/^[a-z][a-z0-9+.-]*:\/[^/]/i.test(raw)) {
      pathSource = new URL(raw.replace(/^([a-z][a-z0-9+.-]*:\/)([^/])/i, "$1/$2")).pathname || "/";
    }
  } catch {
    // fall back to raw
  }

  let path = pathSource.split("?")[0].split("#")[0];
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/+/g, "/");
  path = path.replace(/\/index\.html?$/i, "/");
  path = path.replace(/\/index$/i, "/");
  path = path.replace(/\/_index$/i, "/");

  const langPrefix = path.match(/^\/(zh-cn|zh-tw|en)(\/.*)?$/i);
  if (langPrefix) {
    path = langPrefix[2] || "/";
    if (!path.startsWith("/")) path = `/${path}`;
  }

  if (path !== "/" && !path.endsWith("/")) path = `${path}/`;
  return path;
}
