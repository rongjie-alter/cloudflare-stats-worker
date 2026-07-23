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

const WORKER_VERSION = "2.0.0";

const CACHE_TTL_SECONDS = 30;
const CACHEABLE_PATHS = new Set(["/api/query", "/api/timeseries", "/api/summary", "/api/config"]);
const MAX_QUERY_DAYS = 366;
// Abuse bounds. Attacker-influenced values (dimension strings, filter tokens)
// must never grow unbounded — these cap per-request work and per-isolate memory.
const MAX_DIM_VALUE_LEN = 512; // clamp any single dimension string before it hits D1
const MAX_FILTERS = 20; // max include/exclude tokens honored per query (each is a DB lookup)
const MAX_DIM_CACHE_ENTRIES = 10000; // FIFO cap on the isolate-global dim-id cache

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

// Parent dimension for detail views: child -> parent.
const PARENT_DIMS = {
  browser_version: "browser",
  os_version: "os",
};

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

    const cache = caches.default;
    const shouldCache = method === "GET" && CACHEABLE_PATHS.has(pathname);
    if (shouldCache) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }

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
          response = jsonResponse({ timezone: config.timezone });
          break;
        case "/health":
          response = jsonResponse({ status: "ok", version: WORKER_VERSION, timestamp: new Date().toISOString() });
          break;
        default:
          response = jsonResponse({ error: "Not Found" }, 404);
      }
    } catch (error) {
      console.error("[worker] error", error);
      // Only surface messages we set deliberately (they carry an explicit
      // .status). Unexpected failures (D1 driver text, internal invariants)
      // are masked so we don't leak internals to clients.
      const hasStatus = typeof error.status === "number";
      const status = hasStatus ? error.status : 500;
      const message = hasStatus ? error.message : "Internal Error";
      response = jsonResponse({ error: message }, status);
    }

    if (shouldCache && response.ok) {
      ctx.waitUntil(cache.put(request, response.clone()));
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

  return new Response(null, { status: 204, headers: corsHeaders });
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

  const row = await db
    .prepare(`INSERT INTO ${table}(value) VALUES(?) ON CONFLICT(value) DO UPDATE SET value=excluded.value RETURNING id`)
    .bind(v)
    .first();
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
  const groupBy = url.searchParams.get("group_by") || "path";
  const gb = DIMENSIONS[groupBy];
  if (!gb) {
    return jsonResponse({ error: `Unknown group_by: ${groupBy}` }, 400);
  }
  const { from, to } = resolveRange(url, config);
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 200);

  const includes = parseFilterParam(url, "filter");
  const excludes = parseFilterParam(url, "exclude");

  const binds = [from, to];
  let where = "e.day BETWEEN ? AND ?";

  for (const f of includes) {
    const dim = DIMENSIONS[f.dimension];
    if (!dim) continue;
    const id = await lookupDimId(db, dim.table, f.value);
    if (id === null) {
      // Including a value that was never recorded -> no rows match.
      return jsonResponse(queryEnvelope(metric, from, to, config, groupBy, [], 0), 200, cacheHeaders());
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

  const agg = metric === "visitors" ? "COUNT(DISTINCT e.visitor_id)" : "COUNT(*)";
  const nullLabel = groupBy.startsWith("referrer") ? "(direct)" : "(unknown)";

  const parentGroupBy = PARENT_DIMS[groupBy];
  const pb = parentGroupBy ? DIMENSIONS[parentGroupBy] : null;
  const selectExtra = pb ? `, COALESCE(MAX(pd.value), '') AS parent` : "";
  const joinExtra = pb ? ` LEFT JOIN ${pb.table} pd ON pd.id = e.${pb.col}` : "";

  const sql =
    `SELECT COALESCE(d.value, ?) AS key${selectExtra}, ${agg} AS value ` +
    `FROM events_tab e LEFT JOIN ${gb.table} d ON d.id = e.${gb.col}${joinExtra} ` +
    `WHERE ${where} GROUP BY e.${gb.col} ORDER BY value DESC LIMIT ?`;
  const { results } = await db.prepare(sql).bind(nullLabel, ...binds, limit).all();

  // Total is its own COUNT(DISTINCT) over the filtered set (NOT sum of groups).
  const totalRow = await db.prepare(`SELECT ${agg} AS value FROM events_tab e WHERE ${where}`).bind(...binds).first();
  const total = totalRow ? Number(totalRow.value) : 0;

  const rows = results.map((r) => {
    const row = { key: r.key, value: Number(r.value) };
    if (pb) row.parent = r.parent ?? "";
    return row;
  });
  return jsonResponse(queryEnvelope(metric, from, to, config, groupBy, rows, total), 200, cacheHeaders());
}

function queryEnvelope(metric, from, to, config, groupBy, results, total) {
  const envelope = {
    metric,
    range: { from: dayIntToISO(from), to: dayIntToISO(to), timezone: config.timezone },
    group_by: groupBy,
    results,
    total,
  };
  if (metric === "visitors") {
    envelope.note = "total is distinct visitors over the filtered set; it is not the sum of per-group values (UV is not additive).";
  }
  return envelope;
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
    if (id === null) return jsonResponse(seriesEnvelope(from, to, metric, new Map()), 200, cacheHeaders());
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

  const agg = metric === "visitors" ? "COUNT(DISTINCT e.visitor_id)" : "COUNT(*)";
  const { results } = await db
    .prepare(`SELECT e.day AS day, ${agg} AS value FROM events_tab e WHERE ${where} GROUP BY e.day ORDER BY e.day ASC`)
    .bind(...binds)
    .all();

  const byDay = new Map(results.map((r) => [Number(r.day), Number(r.value)]));
  return jsonResponse(seriesEnvelope(from, to, metric, byDay), 200, cacheHeaders());
}

function seriesEnvelope(from, to, metric, byDay) {
  const results = [];
  for (const day of eachDay(from, to)) {
    results.push({ date: dayIntToISO(day), value: byDay.get(day) || 0 });
  }
  return { metric, interval: "day", results };
}

async function handleSummary(request, env, config) {
  const db = requireD1(env);
  const today = localDay(config.timezone);
  const d7 = localDayOffset(config.timezone, 6);
  const d30 = localDayOffset(config.timezone, 29);

  const pick = (row) => ({ pv: row ? Number(row.pv) : 0, uv: row ? Number(row.uv) : 0 });
  const rangeStmt = (a, b) =>
    db.prepare("SELECT COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv FROM events_tab WHERE day BETWEEN ? AND ?").bind(a, b).first();

  const [todayRow, last7Row, last30Row, allRow, archRow] = await Promise.all([
    rangeStmt(today, today),
    rangeStmt(d7, today),
    rangeStmt(d30, today),
    db.prepare("SELECT COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv FROM events_tab").first(),
    db.prepare("SELECT COALESCE(SUM(pv),0) AS pv FROM events_monthly_tab WHERE dimension = 'total'").first(),
  ]);

  const all = pick(allRow);
  const archivedPv = archRow ? Number(archRow.pv) : 0;

  return jsonResponse(
    {
      timezone: config.timezone,
      today: pick(todayRow),
      last7d: pick(last7Row),
      last30d: pick(last30Row),
      // all-time PV includes pruned months; all-time UV is hot-window only (UV not additive across archives).
      allTime: { pv: all.pv + archivedPv, uv: all.uv, uv_note: "distinct visitors within the retained ~6-month window" },
    },
    200,
    cacheHeaders()
  );
}

// ---------------------------------------------------------------------------
// Scheduled maintenance: refresh daily rollup, archive + prune > 6 months
// ---------------------------------------------------------------------------

async function runMaintenance(env) {
  const db = getD1(env);
  if (!db) return;
  const config = getConfig(env);
  const tz = config.timezone;

  // 1) Refresh site_daily_tab for yesterday and today (idempotent).
  for (const day of [localDayOffset(tz, 1), localDay(tz)]) {
    await db
      .prepare(
        `INSERT INTO site_daily_tab (day, pv, uv)
         SELECT day, COUNT(*), COUNT(DISTINCT visitor_id) FROM events_tab WHERE day = ? GROUP BY day
         ON CONFLICT(day) DO UPDATE SET pv = excluded.pv, uv = excluded.uv`
      )
      .bind(day)
      .run();
  }

  // 2) Archive + prune raw events older than 6 whole months.
  const nowDay = localDay(tz);
  let cy = Math.floor(nowDay / 10000);
  let cm = Math.floor((nowDay % 10000) / 100) - 6;
  while (cm <= 0) {
    cm += 12;
    cy -= 1;
  }
  const cutoffMonth = cy * 100 + cm; // months strictly < this are archived

  const { results: oldMonths } = await db
    .prepare("SELECT DISTINCT (day / 100) AS month FROM events_tab WHERE (day / 100) < ? ORDER BY month ASC")
    .bind(cutoffMonth)
    .all();

  for (const { month } of oldMonths) {
    await archiveMonth(db, Number(month));
  }
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
          `INSERT INTO events_monthly_tab (month, dimension, value, pv, uv)
           SELECT ?, ?, d.value, COUNT(*), COUNT(DISTINCT e.visitor_id)
           FROM events_tab e JOIN ${dim.table} d ON d.id = e.${dim.col}
           WHERE e.day BETWEEN ? AND ? GROUP BY e.${dim.col}
           ON CONFLICT(month, dimension, value) DO UPDATE SET pv = excluded.pv, uv = excluded.uv`
        )
        .bind(month, dimension, start, end)
    );
  }

  await db.batch(statements);
  await db.prepare("DELETE FROM events_tab WHERE day BETWEEN ? AND ?").bind(start, end).run();
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

function cacheHeaders() {
  return { "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}` };
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
