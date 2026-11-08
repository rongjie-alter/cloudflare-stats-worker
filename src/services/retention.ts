// Retention: raw events older than 6 whole months are deleted, together with
// their dim/hier rollup rows. Their site_daily_tab rows are kept forever (one row
// per day), so the all-time cards keep counting pruned days; per-value history
// lives in the Parquet archive.
//
// The delete is spread over nights. A D1 delete bills one written row per row
// removed (measured 2026-11-03: indexes are free on delete, unlike on insert), so
// removing a whole month at once (127K rows on the busiest deployment) is still
// more than the account's 100K/day write budget -- and an exhausted budget makes
// ingest drop real pageviews on every site sharing the account. Instead each run
// deletes oldest day first until a write budget is spent, and carries on the
// next night.
import { DIMENSIONS } from "../dimensions.ts";
import type { Db } from "../db/client.ts";
import { firstDayOfNextMonth, offsetDayInt } from "../lib/days.ts";
import { HIERARCHIES, sealSiteDaily } from "./rollup.ts";
import { archiveCovers } from "./archive-export.ts";
import {
  META_MAX_DAY,
  META_MIN_DAY,
  META_PRUNE_AGG_MONTH,
  invalidateMetaCache,
  raiseMetaMax,
  readMeta,
  type Meta,
} from "./meta.ts";

// Written rows one nightly prune may spend (deleted events + rollup rows + the
// month's site_daily_tab gap fill), across the whole run. Ingest is the other
// consumer of the account-wide 100K/day: ~4 writes per pageview (2 once migration
// 0001 is applied), ~13K pageviews on the busiest day seen so far. Steady state
// needs only ~ingest per night, so this leaves a backlog (a month is ~125K rows)
// draining over about four or five nights without ever being the thing that
// exhausts the day.
export const PRUNE_WRITES_PER_RUN = 30000;

// First day that is still hot: days strictly before it are expired.
export function retentionCutoff(today: number): number {
  let cy = Math.floor(today / 10000);
  let cm = Math.floor((today % 10000) / 100) - 6;
  while (cm <= 0) {
    cm += 12;
    cy -= 1;
  }
  return (cy * 100 + cm) * 100;
}

const changes = (r: D1Result | undefined): number => Number(r?.meta?.changes ?? 0);
const sumChanges = (results: D1Result[]): number => results.reduce((s, r) => s + changes(r), 0);

// Prune expired raw events, oldest day first, spending at most `budget` written
// rows. Stops at the first day the Parquet archive does not cover yet, so raw rows
// are never destroyed before they reach R2.
export async function pruneExpiredDays(env: Env, db: Db, today: number, budget = PRUNE_WRITES_PER_RUN): Promise<void> {
  const d1 = db.$client;
  const cutoffDay = retentionCutoff(today);
  let spent = 0;
  let days = 0;
  let events = 0;

  while (spent < budget) {
    // Oldest remaining expired day. An index min lookup: the old
    // SELECT DISTINCT (day / 100) form wrapped the column in an expression and
    // full-scanned events_tab (~1.35M rows) every night.
    const row = await d1
      .prepare("SELECT MIN(day) AS day FROM events_tab WHERE day < ?")
      .bind(cutoffDay)
      .first<{ day: number | null }>();
    if (!row || row.day === null) break;
    const day = Number(row.day);
    const month = Math.floor(day / 100);

    // The Parquet archive is the only thing that keeps events at row level.
    if (!(await archiveCovers(env, db, day, day))) {
      console.warn(`[worker] not pruning day ${day}: Parquet archive does not cover it yet`);
      break;
    }

    // First day of a month to be pruned: freeze the month while every one of its
    // raw rows is still there. See closeMonth.
    const meta = await readMeta(db);
    if (Number(meta[META_PRUNE_AGG_MONTH] ?? 0) < month) {
      if (!(await archiveCovers(env, db, day, month * 100 + 31))) {
        console.warn(`[worker] not pruning month ${month}: Parquet archive does not cover all of it yet`);
        break;
      }
      spent += await closeMonth(db, month, meta);
      invalidateMetaCache();
    }

    // This day's dim/hier rollup rows (they are only cleanup: nothing reads them
    // once rollup_min_day has moved on), then its events, bounded by what is left.
    const dims = Object.keys(DIMENSIONS);
    const rollupResults = await d1.batch([
      ...dims.map((dimension) => d1.prepare("DELETE FROM dim_daily_tab WHERE dimension = ? AND day = ?").bind(dimension, day)),
      ...Object.keys(HIERARCHIES).map((hier) => d1.prepare("DELETE FROM hier_daily_tab WHERE hier = ? AND day = ?").bind(hier, day)),
    ]);
    spent += sumChanges(rollupResults);

    const room = budget - spent;
    if (room < 1) break;
    const del = await d1
      .prepare("DELETE FROM events_tab WHERE id IN (SELECT id FROM events_tab WHERE day = ? LIMIT ?)")
      .bind(day, room)
      .run();
    const deleted = changes(del);
    // MIN(day) just found a row on this day, so a delete that reports nothing
    // means the next pass would find the same day and spend nothing either:
    // stop rather than spin until the runtime kills the cron.
    if (deleted < 1) {
      console.warn(`[worker] prune made no progress on day ${day}; stopping`);
      break;
    }
    spent += deleted;
    events += deleted;
    days += 1;
    // A full batch may or may not have emptied the day; the next iteration's
    // MIN(day) answers that, and the loop ends once the budget is gone.
  }

  if (days > 0) console.log(`[worker] pruned ${events} events across ${days} day(s), ~${spent}/${budget} writes`);
}

// Freeze one month before its first raw row is deleted, in one transaction:
//
// 1. Seal into site_daily_tab every day of the month the sealed window
//    [rollup_min_day, rollup_max_day] does not cover. Normally there is none and
//    this reads nothing; it scans only the uncovered days otherwise. Those rows
//    are what the all-time cards count once the raw rows are gone.
// 2. Move rollup_min_day past the month: its dim/hier rows are about to go.
// 3. Record prune_agg_month. From now on /api/query and /api/timeseries stop
//    reading the month (meta.ts retainedFloor) rather than count whatever raw rows
//    are left mid-drain, and extendRollupHistory never re-seals it.
//
// Returns the written rows it spent.
async function closeMonth(db: Db, month: number, meta: Meta): Promise<number> {
  const d1 = db.$client;
  const start = month * 100 + 1;
  const end = offsetDayInt(firstDayOfNextMonth(month), -1);
  const statements = uncoveredDays(start, end, Number(meta[META_MIN_DAY] ?? 0), Number(meta[META_MAX_DAY] ?? 0)).map(
    ([from, to]) => sealSiteDaily(d1, from, to)
  );
  const sealCount = statements.length;
  statements.push(raiseMetaMax(d1, META_MIN_DAY, firstDayOfNextMonth(month)), raiseMetaMax(d1, META_PRUNE_AGG_MONTH, month));

  const results = await d1.batch(statements);
  const sealed = sumChanges(results.slice(0, sealCount));
  console.log(`[worker] closed month ${month}${sealed ? `, sealed ${sealed} missing site_daily_tab day(s)` : ""}`);
  return sumChanges(results);
}

// The parts of [start, end] outside the sealed window [minDay, maxDay] (0 = none).
export function uncoveredDays(start: number, end: number, minDay: number, maxDay: number): [number, number][] {
  if (!minDay || !maxDay || maxDay < start || minDay > end) return [[start, end]];
  const out: [number, number][] = [];
  if (minDay > start) out.push([start, offsetDayInt(minDay, -1)]);
  if (maxDay < end) out.push([offsetDayInt(maxDay, 1), end]);
  return out;
}
