// Per-deployment configuration, read from wrangler `[vars]` (env).
// Makes the worker reusable for different websites without code changes.

const DEFAULTS = {
  WORKER_DOMAIN: "",
  ALLOWED_ORIGIN: "",
  RATE_LIMIT_PER_MINUTE: 120,
  TIMEZONE: "Asia/Tokyo",
};

/**
 * Resolve and validate configuration from env vars.
 * @returns {{workerDomain:string, allowedOrigin:string, rateLimitPerMinute:number, timezone:string}}
 */
export function getConfig(env) {
  const rateLimit = Number.parseInt(env.RATE_LIMIT_PER_MINUTE ?? "", 10);
  return {
    workerDomain: (env.WORKER_DOMAIN || DEFAULTS.WORKER_DOMAIN).trim(),
    allowedOrigin: (env.ALLOWED_ORIGIN || DEFAULTS.ALLOWED_ORIGIN).trim().replace(/\/+$/, ""),
    rateLimitPerMinute: Number.isFinite(rateLimit) && rateLimit > 0 ? rateLimit : DEFAULTS.RATE_LIMIT_PER_MINUTE,
    timezone: (env.TIMEZONE || DEFAULTS.TIMEZONE).trim(),
  };
}

/**
 * The request's origin, from the Origin header, falling back to the Referer's origin.
 * @returns {string|null} e.g. "https://blog.example.com" or null
 */
export function resolveRequestOrigin(request) {
  const origin = request.headers.get("Origin");
  if (origin) {
    return origin.replace(/\/+$/, "");
  }
  const referer = request.headers.get("Referer");
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

function isDevOrigin(origin) {
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

/**
 * True if `origin` is the single allowed reporting site, or a local dev host.
 */
export function isAllowedOrigin(origin, config) {
  if (!origin) return false;
  if (config.allowedOrigin && origin === config.allowedOrigin) return true;
  return isDevOrigin(origin);
}

/**
 * CORS headers for the ingest endpoint. Echoes back only a matched origin; a
 * non-matching request gets no `Access-Control-Allow-Origin` (browser blocks it).
 */
export function corsHeadersFor(request, config) {
  const origin = resolveRequestOrigin(request);
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (isAllowedOrigin(origin, config)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/**
 * Local calendar day in the configured timezone, as an integer yyyymmdd.
 * Workers run in UTC but ship full ICU, so Intl handles the tz + DST correctly.
 * @param {string} timezone IANA tz, e.g. "Asia/Tokyo"
 * @param {Date} [date] defaults to now
 */
export function localDay(timezone, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return Number(parts.replaceAll("-", "")); // "2026-07-19" -> 20260719
}

/**
 * yyyymmdd integer for `n` days before the configured-tz "today".
 * Computed by shifting a UTC-noon anchor to avoid DST edge slips.
 */
export function localDayOffset(timezone, offsetDays, date = new Date()) {
  const shifted = new Date(date.getTime() - offsetDays * 86400000);
  return localDay(timezone, shifted);
}
