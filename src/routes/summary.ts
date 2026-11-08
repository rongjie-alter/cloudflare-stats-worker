// GET /api/summary -- headline cards (today / 7d / 30d / all-time).
//
// PV is live and exact on every card: it is additive, so sealed days come from
// site_daily_tab and today is counted straight off events_tab. site_daily_tab
// keeps its rows after the raw events are pruned (one per day), so the all-time
// card covers every day ever sealed, not just the retained ~6 months.
//
// UV is a DAILY metric. Visitor ids are salted per day (visitor-salt.ts), so the
// same person has a different id each day and a distinct count over several days
// would just be the sum of the daily ones. Today's UV is computed live; each
// wider window reports avg / min / max of the per-day UV over the CLOSED days in
// it, straight from site_daily_tab.uv. Today is left out of those figures because
// a partial day would drag the min and the average down. Days with no traffic have
// no row, so `days` counts days with traffic.
import { Hono } from "hono";
import { localDay, localDayOffset } from "../config.ts";
import type { AppEnv } from "../env.ts";
import { cacheHeaders, jsonResponse } from "../http.ts";
import { offsetDayInt } from "../lib/days.ts";
import { withDb } from "../middleware.ts";
import { META_MAX_DAY, readMeta } from "../services/meta.ts";

export const summary = new Hono<AppEnv>();

interface SealedRow {
  pv: number;
  days: number;
  uv_sum: number;
  uv_min: number | null;
  uv_max: number | null;
}
interface DayRow {
  day: number;
  pv: number;
  uv: number;
}

export interface DailyUv {
  avg: number;
  min: number;
  max: number;
  days: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

summary.all("/api/summary", withDb, async (c) => {
  const { config, db } = c.var;
  const d1 = db.$client;
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

  const sealed = (a: number, b: number): Promise<SealedRow | null> =>
    b < a
      ? Promise.resolve(null)
      : d1
          .prepare(
            "SELECT COALESCE(SUM(pv),0) AS pv, COUNT(*) AS days, COALESCE(SUM(uv),0) AS uv_sum, " +
              "MIN(uv) AS uv_min, MAX(uv) AS uv_max FROM site_daily_tab WHERE day BETWEEN ? AND ?"
          )
          .bind(a, b)
          .first<SealedRow>();

  const [todayRow, unsealed, sealed7, sealed30, sealedAll] = await Promise.all([
    d1
      .prepare("SELECT COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv FROM events_tab WHERE day = ?")
      .bind(today)
      .first<{ pv: number; uv: number }>(),
    // Per-day PV and UV for the unsealed tail, so each window can take its own slice.
    unsealedFrom > yesterday
      ? Promise.resolve({ results: [] as DayRow[] })
      : d1
          .prepare(
            "SELECT day, COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv FROM events_tab " +
              "WHERE day BETWEEN ? AND ? GROUP BY day"
          )
          .bind(unsealedFrom, yesterday)
          .all<DayRow>(),
    sealed(d7, sealedTo),
    sealed(d30, sealedTo),
    sealed(0, sealedTo),
  ]);

  const todayPv = todayRow ? Number(todayRow.pv) : 0;
  const tail = (from: number): DayRow[] => unsealed.results.filter((r) => Number(r.day) >= from);

  // PV for one window = sealed days + unsealed tail within the window + today.
  const windowPv = (row: SealedRow | null, from: number): number =>
    (row ? Number(row.pv) : 0) + tail(from).reduce((sum, r) => sum + Number(r.pv), 0) + todayPv;

  // Daily UV for one window = sealed days + unsealed tail within the window, no today.
  const windowUv = (row: SealedRow | null, from: number): DailyUv | null => {
    const extra = tail(from);
    let days = row ? Number(row.days) : 0;
    let sum = row ? Number(row.uv_sum) : 0;
    let min = row && row.uv_min !== null ? Number(row.uv_min) : Infinity;
    let max = row && row.uv_max !== null ? Number(row.uv_max) : -Infinity;
    for (const r of extra) {
      const uv = Number(r.uv);
      days += 1;
      sum += uv;
      min = Math.min(min, uv);
      max = Math.max(max, uv);
    }
    return days === 0 ? null : { avg: round1(sum / days), min, max, days };
  };

  return jsonResponse(
    {
      timezone: config.timezone,
      today: { pv: todayPv, uv: todayRow ? Number(todayRow.uv) : 0 },
      last7d: { pv: windowPv(sealed7, d7), uv: windowUv(sealed7, d7) },
      last30d: { pv: windowPv(sealed30, d30), uv: windowUv(sealed30, d30) },
      // Pruned days included: their site_daily_tab rows outlive the raw events.
      allTime: {
        pv: windowPv(sealedAll, 0),
        uv: windowUv(sealedAll, 0),
        uv_note: "daily visitors over every closed day on record",
      },
    },
    200,
    cacheHeaders(today, config)
  );
});
