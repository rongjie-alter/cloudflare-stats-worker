import type {
  Filter,
  QueryParams,
  QueryResponse,
  SummaryResponse,
  TimeseriesResponse,
} from "./types";

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  at: number;
  promise: Promise<any>;
}
const cache = new Map<string, CacheEntry>();

function encodeFilters(filters: Filter[]): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const f of filters) {
    const token = `${f.dimension}:${f.value}`;
    (f.op === "exclude" ? exclude : include).push(token);
  }
  return { include, exclude };
}

function buildUrl(path: string, params: Record<string, string | number | undefined>, filters?: Filter[]): string {
  const u = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  }
  if (filters && filters.length) {
    const { include, exclude } = encodeFilters(filters);
    if (include.length) u.searchParams.set("filter", include.join(","));
    if (exclude.length) u.searchParams.set("exclude", exclude.join(","));
  }
  return u.pathname + u.search;
}

async function getJSON<T>(url: string): Promise<T> {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.promise as Promise<T>;

  const promise = fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return r.json();
    })
    .catch((err) => {
      cache.delete(url); // don't cache failures
      throw err;
    });

  cache.set(url, { at: now, promise });
  return promise as Promise<T>;
}

export function query(p: QueryParams): Promise<QueryResponse> {
  const url = buildUrl(
    "/api/query",
    { metric: p.metric, from: p.from, to: p.to, group_by: p.groupBy, limit: p.limit },
    p.filters
  );
  return getJSON<QueryResponse>(url);
}

export function timeseries(p: {
  metric: QueryParams["metric"];
  from: string;
  to: string;
  filters: Filter[];
}): Promise<TimeseriesResponse> {
  const url = buildUrl("/api/timeseries", { metric: p.metric, from: p.from, to: p.to }, p.filters);
  return getJSON<TimeseriesResponse>(url);
}

export function summary(): Promise<SummaryResponse> {
  return getJSON<SummaryResponse>("/api/summary");
}

export function fetchConfig(): Promise<{ timezone: string }> {
  return getJSON<{ timezone: string }>("/api/config");
}
