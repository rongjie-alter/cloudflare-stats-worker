// The Month-over-Month queries. Each runs once per side against the rows
// already in DuckDB, so a filter change is a handful of in-memory scans.
import type { Dimension } from "../api/types";
import { query, tableFor } from "./db";
import { nullLabel } from "./sql";

// One side of the comparison: a month of one source, cut to [from, to].
export interface Side {
  source: string;
  month: number; // yyyymm
  from: number; // yyyymmdd
  to: number; // yyyymmdd
}

export interface Where {
  sql: string;
  params: unknown[];
}

export interface Totals {
  pv: number;
  uv: number;
  days: number;
}

export interface TrendPoint {
  dom: number; // day of month
  pv: number;
  uv: number;
}

export interface BreakdownRow {
  key: string;
  pvA: number;
  pvB: number;
  uvA: number;
  uvB: number;
}

// Last day-of-month with any data (unfiltered): how far a month is covered.
export async function coverage(source: string, month: number): Promise<number> {
  const [row] = await query<{ last: number | null }>(
    `SELECT MAX(day % 100) AS last FROM ${tableFor(source)} WHERE day BETWEEN ? AND ?`,
    [month * 100 + 1, month * 100 + 31]
  );
  return row?.last ?? 0;
}

export async function totals(side: Side, where: Where): Promise<Totals> {
  const [row] = await query<Totals>(
    `SELECT COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv, COUNT(DISTINCT day) AS days
     FROM ${tableFor(side.source)} WHERE day BETWEEN ? AND ?${where.sql}`,
    [side.from, side.to, ...where.params]
  );
  return row ?? { pv: 0, uv: 0, days: 0 };
}

export async function trend(side: Side, where: Where): Promise<TrendPoint[]> {
  return query<TrendPoint>(
    `SELECT day % 100 AS dom, COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv
     FROM ${tableFor(side.source)} WHERE day BETWEEN ? AND ?${where.sql}
     GROUP BY 1 ORDER BY 1`,
    [side.from, side.to, ...where.params]
  );
}

async function breakdownSide(side: Side, dim: Dimension, where: Where) {
  // `dim` is a whitelisted Dimension, safe as an identifier.
  return query<{ k: string; pv: number; uv: number }>(
    `SELECT COALESCE(${dim}, ?) AS k, COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv
     FROM ${tableFor(side.source)} WHERE day BETWEEN ? AND ?${where.sql}
     GROUP BY 1`,
    [nullLabel(dim), side.from, side.to, ...where.params]
  );
}

// Every value seen in either month, with both months' counts side by side.
export async function breakdown(a: Side, b: Side, dim: Dimension, where: Where): Promise<BreakdownRow[]> {
  const [ra, rb] = await Promise.all([breakdownSide(a, dim, where), breakdownSide(b, dim, where)]);
  const rows = new Map<string, BreakdownRow>();
  const get = (key: string) => {
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { key, pvA: 0, pvB: 0, uvA: 0, uvB: 0 }));
    return r;
  };
  for (const r of ra) Object.assign(get(r.k), { pvA: r.pv, uvA: r.uv });
  for (const r of rb) Object.assign(get(r.k), { pvB: r.pv, uvB: r.uv });
  return [...rows.values()].sort((x, y) => y.pvA + y.pvB - (x.pvA + x.pvB));
}
