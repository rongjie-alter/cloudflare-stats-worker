// The Reports queries. Each takes one range and answers it from the `events`
// view already in DuckDB, so a filter change is a handful of in-memory scans.
// The view runs a query once per side: for the primary range and, when
// comparing, again for the comparison range.
import type { AggregateRow, Dimension, TupleRow } from "../api/types";
import { query, type DayRange } from "./db";
import { nullLabel } from "./sql";

export interface Where {
  sql: string;
  params: unknown[];
}

// Visitors are a DAILY metric: ids are salted per day on the server, so the same
// person has a different visitor_id every day and a distinct count over several
// days would only be the sum of the daily ones. Every `uv` below is therefore
// computed per day first and then averaged over the range's days. The average's
// denominator is every day in the range that has events at all, whatever the
// filters (the same definition as /api/query and /api/summary), so a day on which
// nothing matched the filters counts as 0 visitors rather than being skipped.
// (Days stored before the salt existed have stable ids, but their per-day distinct
// counts are identical, so old and new days mix freely.)
export interface Totals {
  pv: number;
  uv: number; // average daily visitors
  uvMin: number; // fewest visitors on any day (0 if a day had no match)
  uvMax: number; // most visitors on any day
  days: number; // days with data that MATCH the filters; page views / day divides by it
}

export interface TrendPoint {
  day: number; // yyyymmdd
  pv: number;
  uv: number; // visitors that day
}

export interface CountRow {
  key: string;
  pv: number;
  uv: number; // average daily visitors
}

export interface CountTuple {
  keys: string[]; // one per level, outermost first; shorter than the query's levels for a subtotal
  pv: number;
  uv: number; // average daily visitors
}

export type Metric = "pv" | "uv";

const round1 = (n: number): number => Math.round(Number(n) * 10) / 10;

// The range's days with data, regardless of filters. Binds two params.
const DAYS_CTE = "days AS (SELECT DISTINCT day FROM events WHERE day BETWEEN ? AND ?)";
const DAY_COUNT = "GREATEST((SELECT COUNT(*) FROM days), 1)";

export async function totals(range: DayRange, where: Where): Promise<Totals> {
  const [row] = await query<Totals>(
    `WITH ${DAYS_CTE},
          per AS (SELECT day, COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv
                  FROM events WHERE day BETWEEN ? AND ?${where.sql} GROUP BY day)
     SELECT CAST(COALESCE(SUM(p.pv), 0) AS BIGINT) AS pv,
            CAST(COALESCE(AVG(COALESCE(p.uv, 0)), 0) AS DOUBLE) AS uv,
            CAST(COALESCE(MIN(COALESCE(p.uv, 0)), 0) AS BIGINT) AS "uvMin",
            CAST(COALESCE(MAX(COALESCE(p.uv, 0)), 0) AS BIGINT) AS "uvMax",
            COUNT(p.day) AS days
     FROM days d LEFT JOIN per p ON p.day = d.day`,
    [range.from, range.to, range.from, range.to, ...where.params]
  );
  return row ? { ...row, uv: round1(row.uv) } : { pv: 0, uv: 0, uvMin: 0, uvMax: 0, days: 0 };
}

export async function trend(range: DayRange, where: Where): Promise<TrendPoint[]> {
  return query<TrendPoint>(
    `SELECT day, COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv
     FROM events WHERE day BETWEEN ? AND ?${where.sql}
     GROUP BY day ORDER BY day`,
    [range.from, range.to, ...where.params]
  );
}

// `dim` is a whitelisted Dimension, safe as an identifier.
export async function breakdown(range: DayRange, dim: Dimension, where: Where): Promise<CountRow[]> {
  const rows = await query<{ k: string; pv: number; uv: number }>(
    `WITH ${DAYS_CTE},
          per AS (SELECT COALESCE(${dim}, ?) AS k, day, COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS u
                  FROM events WHERE day BETWEEN ? AND ?${where.sql} GROUP BY 1, 2)
     SELECT k, CAST(SUM(pv) AS BIGINT) AS pv, CAST(SUM(u) AS DOUBLE) / ${DAY_COUNT} AS uv
     FROM per GROUP BY k`,
    [range.from, range.to, nullLabel(dim), range.from, range.to, ...where.params]
  );
  return rows.map((r) => ({ key: r.k, pv: r.pv, uv: round1(r.uv) }));
}

// A hierarchy in one statement, with GROUP BY ROLLUP so that every prefix also
// gets a row of its own. A visitor on two browser versions is one browser, so a
// parent ring cannot be the sum of its children: the ROLLUP rows carry the exact
// distinct count for each parent, per day, and the outer query averages those.
export async function tuples(range: DayRange, dims: Dimension[], where: Where): Promise<CountTuple[]> {
  const ks = dims.map((_, i) => `k${i}`);
  const inner = dims.map((d, i) => `COALESCE(${d}, ?) AS k${i}`).join(", ");
  const rows = await query<Record<string, unknown>>(
    `WITH ${DAYS_CTE},
          per AS (SELECT day, ${ks.join(", ")}, ${ks.map((k, i) => `GROUPING(${k}) AS g${i}`).join(", ")},
                         COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS u
                  FROM (SELECT day, visitor_id, ${inner} FROM events WHERE day BETWEEN ? AND ?${where.sql})
                  GROUP BY day, ROLLUP(${ks.join(", ")})
                  HAVING GROUPING(k0) = 0)
     SELECT ${ks.join(", ")}, ${ks.map((_, i) => `g${i}`).join(", ")},
            CAST(SUM(pv) AS BIGINT) AS pv, CAST(SUM(u) AS DOUBLE) / ${DAY_COUNT} AS uv
     FROM per GROUP BY ${ks.join(", ")}, ${ks.map((_, i) => `g${i}`).join(", ")}`,
    [range.from, range.to, ...dims.map(nullLabel), range.from, range.to, ...where.params]
  );
  return rows.map((r) => {
    let depth = 0;
    while (depth < dims.length && Number(r[`g${depth}`]) === 0) depth += 1;
    return { keys: ks.slice(0, depth).map((k) => String(r[k])), pv: Number(r.pv), uv: round1(Number(r.uv)) };
  });
}

// --- Merging the two sides ---------------------------------------------------------

// Current rows with the comparison period's value alongside. A value present in
// only one period still gets a row, with 0 on the other side.
export function mergeBreakdown(cur: CountRow[], prev: CountRow[] | null, metric: Metric): AggregateRow[] {
  const rows = new Map<string, AggregateRow>();
  for (const r of cur) rows.set(r.key, { key: r.key, value: r[metric], ...(prev ? { prev: 0 } : {}) });
  if (prev) {
    for (const r of prev) {
      const row = rows.get(r.key);
      if (row) row.prev = r[metric];
      else rows.set(r.key, { key: r.key, value: 0, prev: r[metric] });
    }
  }
  return [...rows.values()].sort((a, b) => b.value - a.value || (b.prev ?? 0) - (a.prev ?? 0));
}

export function mergeTuples(cur: CountTuple[], prev: CountTuple[] | null, metric: Metric): TupleRow[] {
  const id = (keys: string[]) => keys.join("\u0001");
  const rows = new Map<string, TupleRow>();
  for (const r of cur) rows.set(id(r.keys), { keys: r.keys, value: r[metric], ...(prev ? { prev: 0 } : {}) });
  if (prev) {
    for (const r of prev) {
      const row = rows.get(id(r.keys));
      if (row) row.prev = r[metric];
      else rows.set(id(r.keys), { keys: r.keys, value: 0, prev: r[metric] });
    }
  }
  return [...rows.values()];
}

// --- Trend alignment ------------------------------------------------------------------

const ms = (day: number) => Date.UTC(Math.floor(day / 10000), Math.floor((day % 10000) / 100) - 1, day % 100);

// A series indexed by day offset from the range start, so ranges of different
// lengths (or weekday-matched comparisons) overlay point for point. A day with no
// events is a gap (null): no data is not the same as no traffic.
export function alignTrend(points: TrendPoint[], range: DayRange, metric: Metric, length: number): (number | null)[] {
  const out: (number | null)[] = new Array(length).fill(null);
  const start = ms(range.from);
  for (const p of points) {
    const i = Math.round((ms(p.day) - start) / 86400000);
    if (i >= 0 && i < length) out[i] = p[metric];
  }
  return out;
}
