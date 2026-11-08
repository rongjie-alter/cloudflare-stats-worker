// User-Agent parsing, bot/AI-crawler exclusion, and referrer parsing.
//
// Bot exclusion is a hard requirement: bot traffic is never recorded. We gate
// on two layers — (1) a deterministic regex covering AI crawlers and generic
// bot tokens (fast, explicit, easy to extend), and (2) ua-parser-js's Crawlers
// extension (browser.type === 'crawler'). Either match => excluded.

import { UAParser } from "ua-parser-js";
import { Crawlers } from "ua-parser-js/extensions";

// AI crawlers + assistants. These often are NOT in generic bot lists, so we
// list them explicitly. Keep this updated as new agents appear.
const AI_CRAWLER_RE =
  /(GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|anthropic-ai|CCBot|Google-Extended|GoogleOther|PerplexityBot|Perplexity-User|Bytespider|Amazonbot|Applebot-Extended|meta-externalagent|meta-externalfetcher|FacebookBot|Diffbot|ImagesiftBot|Omgilibot|Omgili|YouBot|cohere-ai|DuckAssistBot|Timpibot|Kangaroo Bot|PetalBot|Scrapy|python-requests|node-fetch|axios|Go-http-client|Java\/|okhttp|libwww-perl|curl\/|Wget)/i;

// Generic bot / crawler / monitoring tokens.
const GENERIC_BOT_RE =
  /(bot|crawler|crawl|spider|slurp|mediapartners|feedfetcher|facebookexternalhit|bingpreview|headlesschrome|phantomjs|lighthouse|pingdom|uptimerobot|statuscake|gtmetrix|pagespeed|chrome-lighthouse|prerender|dataprovider|semrush|ahrefs|mj12bot|dotbot|screaming frog|archive\.org_bot|ia_archiver)/i;

/**
 * Returns true if the User-Agent belongs to a bot / crawler / non-human client.
 * Empty or missing UA is treated as a bot (real browsers always send one).
 */
export function isBot(userAgent: unknown): boolean {
  if (!userAgent || typeof userAgent !== "string") {
    return true;
  }
  if (AI_CRAWLER_RE.test(userAgent) || GENERIC_BOT_RE.test(userAgent)) {
    return true;
  }
  try {
    const { type } = new UAParser(userAgent, Crawlers).getBrowser();
    if (type === "crawler") {
      return true;
    }
  } catch {
    // parser/extension issue: fall back to regex result (already false here)
  }
  return false;
}

const UNKNOWN = "Unknown";

function clean(value: unknown): string {
  if (value === undefined || value === null) return UNKNOWN;
  const s = `${value}`.trim();
  return s ? s : UNKNOWN;
}

// Browser version is stored as major version only (e.g. "153" from
// "153.0.8010.24") -- point releases don't change what web features are
// supported and only bloat the dimension table / widen the dashboard.
function majorVersion(value: string): string {
  if (value === UNKNOWN) return value;
  return value.split(".")[0] || UNKNOWN;
}

/**
 * Parse a User-Agent into normalized OS / browser / device dimensions.
 * device.type is normalized to 'desktop' when ua-parser-js leaves it undefined.
 */
export interface ParsedUserAgent {
  os: { name: string; version: string };
  browser: { name: string; version: string };
  device: { type: string; vendor: string; model: string };
}

/**
 * User-Agent Client Hints reported by the beacon (navigator.userAgentData).
 * Chromium freezes the UA string (Android "10; K", Windows "NT 10.0", macOS
 * "10_15_7"), so the real OS version and device model only exist as hints.
 */
export interface ClientHints {
  platform?: string;
  platformVersion?: string;
  model?: string;
  mobile?: boolean;
}

// Platforms navigator.userAgentData reports. Anything else is forged or unknown.
const HINT_PLATFORMS = new Set(["Android", "Chrome OS", "Chromium OS", "Linux", "macOS", "Windows"]);
// "14", "14.0.0", "10.0.22631"
const HINT_VERSION_RE = /^\d+(\.\d+){0,3}$/;
// Printable model names ("SM-S918B", "Pixel 7", "moto g(60)").
const HINT_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._+()-]*$/;
// Models are stored as a dimension, so cap them hard: fewer, shorter values.
const HINT_MODEL_MAX_LENGTH = 20;

/**
 * The hints arrive in a client-controlled JSON body and end up as dimension
 * values, so each field is checked against a closed shape: platform from a fixed
 * list, version numeric, model printable and short. Anything else is dropped (not
 * repaired), so a forged value falls back to what the UA string says.
 */
export function sanitizeHints(raw: unknown): ClientHints {
  if (!raw || typeof raw !== "object") return {};
  const input = raw as Record<string, unknown>;
  const hints: ClientHints = {};
  if (typeof input.platform === "string" && HINT_PLATFORMS.has(input.platform)) {
    hints.platform = input.platform;
  }
  if (typeof input.platformVersion === "string" && HINT_VERSION_RE.test(input.platformVersion.trim())) {
    hints.platformVersion = input.platformVersion.trim();
  }
  if (typeof input.model === "string") {
    const model = input.model.trim();
    if (HINT_MODEL_RE.test(model)) hints.model = model.slice(0, HINT_MODEL_MAX_LENGTH).trim();
  }
  if (typeof input.mobile === "boolean") hints.mobile = input.mobile;
  return hints;
}

// Hints only replace what UA reduction froze, and only on the OS families whose
// UA is actually reduced: Android (version + model), Windows (11 is "NT 10.0"),
// macOS (always 10_15_7). Linux/ChromeOS UAs are not reduced, and a Linux hint
// would also overwrite UA-derived names like "Ubuntu". The hint platform must
// agree with the UA's OS, so hints can never switch a visit to another OS.
const HINT_OS_FAMILIES = new Set(["Android", "Windows", "macOS"]);

function applicableHints(uaOsName: string | undefined, hints: ClientHints): ClientHints {
  if (!uaOsName || !HINT_OS_FAMILIES.has(uaOsName) || hints.platform !== uaOsName) return {};
  const out: ClientHints = { platform: hints.platform };
  if (hints.platformVersion) out.platformVersion = hints.platformVersion;
  if (hints.mobile !== undefined) out.mobile = hints.mobile;
  // Only Android reports a meaningful device model.
  if (uaOsName === "Android" && hints.model) out.model = hints.model;
  return out;
}

// ua-parser-js reads client hints in their HTTP header form (structured-header
// strings), so serialize ours the same way.
function hintsToHeaders(hints: ClientHints): Record<string, string> {
  const headers: Record<string, string> = {};
  if (hints.platform) headers["sec-ch-ua-platform"] = `"${hints.platform}"`;
  if (hints.platformVersion) headers["sec-ch-ua-platform-version"] = `"${hints.platformVersion}"`;
  if (hints.model) headers["sec-ch-ua-model"] = `"${hints.model}"`;
  if (hints.mobile !== undefined) headers["sec-ch-ua-mobile"] = hints.mobile ? "?1" : "?0";
  return headers;
}

export function parseUserAgent(userAgent: string, rawHints?: unknown): ParsedUserAgent {
  let parser = new UAParser(userAgent || "");
  const hints = applicableHints(parser.getOS().name, sanitizeHints(rawHints));
  const hasHints = Object.keys(hints).length > 0;
  if (hasHints) parser = new UAParser(userAgent || "", hintsToHeaders(hints));
  const browser = parser.getBrowser();
  // Only OS and device are overridden: Chrome's major version is not reduced, so
  // the UA already has the right browser.
  // withClientHints() is typed as T | PromiseLike<T> because in a browser it awaits
  // navigator.userAgentData. Workers has no userAgentData, so it is synchronous here.
  const os = hasHints ? (parser.getOS().withClientHints() as ReturnType<typeof parser.getOS>) : parser.getOS();
  const device = hasHints
    ? (parser.getDevice().withClientHints() as ReturnType<typeof parser.getDevice>)
    : parser.getDevice();

  return {
    os: { name: clean(os.name), version: majorVersion(clean(os.version)) },
    browser: { name: clean(browser.name), version: majorVersion(clean(browser.version)) },
    device: {
      type: device.type ? clean(device.type) : "desktop",
      vendor: clean(device.vendor),
      model: clean(device.model),
    },
  };
}

/**
 * Parse the client-reported referrer (document.referrer) into a domain.
 * - empty referrer            => { domain: null }  (direct)
 * - same-origin as the site   => { domain: '(internal)' }
 * - external                  => { domain: <hostname> }
 *
 * `referrer` is the raw document.referrer from the beacon payload; `siteOrigin`
 * the configured allowed site origin (for internal detection).
 */
export function parseReferrer(referrer: unknown, siteOrigin: string): { domain: string | null } {
  if (!referrer || typeof referrer !== "string") {
    return { domain: null };
  }
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return { domain: null };
  }

  let siteHost: string | null = null;
  if (siteOrigin) {
    try {
      siteHost = new URL(siteOrigin).hostname;
    } catch {
      siteHost = null;
    }
  }

  const domain = siteHost && url.hostname === siteHost ? "(internal)" : url.hostname;
  return { domain };
}
