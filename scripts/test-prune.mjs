#!/usr/bin/env node
// The nightly prune spreads a month over several runs. Prove that doing so
// changes no number: the all-time PV card must be unchanged after EVERY run, not
// just the last one, and the expired days must end up as site_daily_tab rows only
// (raw events and dim/hier rollups gone, site_daily_tab kept forever).
//
//   node scripts/test-prune.mjs
//
// Runs against a throwaway local D1 (miniflare, via wrangler's getPlatformProxy)
// with the repo's migrations applied. Nothing remote is touched.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { createDb } from "../src/db/client.ts";
import { pruneExpiredDays, retentionCutoff, uncoveredDays } from "../src/services/retention.ts";
import { sealDays, extendRollupHistory } from "../src/services/rollup.ts";
import { invalidateMetaCache, readMeta, retainedFloor } from "../src/services/meta.ts";

// Days of a month the sealed window misses, which the prune seals before deleting.
assert.deepEqual(uncoveredDays(20260701, 20260731, 20260601, 20261107), [], "covered month");
assert.deepEqual(uncoveredDays(20260701, 20260731, 20260710, 20261107), [[20260701, 20260709]], "late min");
assert.deepEqual(uncoveredDays(20260701, 20260731, 20260601, 20260720), [[20260721, 20260731]], "early max");
assert.deepEqual(uncoveredDays(20260701, 20260731, 20260710, 20260720), [[20260701, 20260709], [20260721, 20260731]], "both");
assert.deepEqual(uncoveredDays(20260701, 20260731, 20260801, 20261107), [[20260701, 20260731]], "after the month");
assert.deepEqual(uncoveredDays(20260701, 20260731, 0, 0), [[20260701, 20260731]], "nothing sealed");

// "covered": the sealed window already holds every July day. "gap": it starts
// after July 29, so the prune must seal that day into site_daily_tab before its
// raw rows go, or the all-time card would lose it.
for (const source of ["covered", "gap"]) {
  const dir = mkdtempSync(join(tmpdir(), "prune-test-"));
  const configPath = join(dir, "wrangler.toml");
  writeFileSync(
    configPath,
    `name = "prune-test"\ncompatibility_date = "2025-10-07"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "prune_test_db"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\n`
  );

  const { env, dispose } = await getPlatformProxy({ configPath, persist: { path: join(dir, "state") } });
  try {
    console.log(`sealed window ${source === "covered" ? "covers July" : "misses July 29"}:`);
    await main(env.DB, source);
    console.log("OK: pruning over several nights changes no number");
  } finally {
    await dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(d1, source) {
  // Schema: the repo's own migrations.
  const migrations = new URL("../drizzle/", import.meta.url);
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(file, migrations), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
      await d1.prepare(stmt).run();
    }
  }
  const db = createDb(d1);

  // today = 2027-02-01 => cutoff 20260800: July is expired, August onward is hot.
  const today = 20270201;
  const cutoff = retentionCutoff(today);
  assert.equal(cutoff, 20260800);

  const first = (sql, ...binds) => d1.prepare(sql).bind(...binds).first();
  for (const t of ["dim_path_tab", "dim_country_tab"]) {
    for (const v of ["a", "b", "c", "d"]) await d1.prepare(`INSERT INTO ${t} (value) VALUES (?)`).bind(v).run();
  }

  // Expired July 29-31 (uneven sizes, one day larger than the per-run budget
  // allows), plus August 1-2 that must survive untouched.
  const perDay = { 20260729: 40, 20260730: 7, 20260731: 90, 20260801: 12, 20260802: 5 };
  let id = 0;
  let total = 0;
  const statements = [];
  const visitorsPerDay = {};
  for (const [day, n] of Object.entries(perDay)) {
    visitorsPerDay[day] = new Set();
    for (let i = 0; i < n; i += 1) {
      id += 1;
      visitorsPerDay[day].add(id % 23);
      statements.push(
        d1
          .prepare("INSERT INTO events_tab (day, visitor_id, path_id, country_id) VALUES (?, ?, ?, ?)")
          .bind(Number(day), id % 23, (id % 4) + 1, id % 3 === 0 ? null : (id % 4) + 1)
      );
    }
    total += n;
  }
  for (let i = 0; i < statements.length; i += 50) await d1.batch(statements.slice(i, i + 50));
  const julyTotal = perDay[20260729] + perDay[20260730] + perDay[20260731];

  await sealDays(db, source === "covered" ? 20260701 : 20260730, 20260802);
  invalidateMetaCache();

  // What /api/summary sums for the all-time card (no today in this data).
  const allTimePv = async () => Number((await first("SELECT COALESCE(SUM(pv),0) AS n FROM site_daily_tab")).n);
  const unsealed = source === "gap" ? perDay[20260729] : 0;
  assert.equal(await allTimePv(), total - unsealed, "all-time PV before pruning");

  // A tiny budget: a delete bills 1 written row per row removed (indexes are free),
  // so this is ~50 events a run plus rollup rows and the one-off monthly aggregate.
  const budget = 50;
  let runs = 0;
  for (; runs < 100; runs += 1) {
    const left = Number((await first("SELECT COUNT(*) AS n FROM events_tab WHERE day < ?", cutoff)).n);
    if (left === 0) break;
    await pruneExpiredDays({}, db, today, budget);
    invalidateMetaCache();
    // The first run seals the gap, so from here on every July pageview counts.
    assert.equal(await allTimePv(), total, `all-time PV wrong after run ${runs + 1}`);
    // From the first run on, range reads skip July entirely instead of counting
    // whatever is left of it.
    assert.equal(retainedFloor(await readMeta(db)), 20260801, `read floor after run ${runs + 1}`);
    // The rollup backfill must not re-seal days whose month is already aggregated.
    await extendRollupHistory(db, cutoff);
    invalidateMetaCache();
    assert.equal(await allTimePv(), total, `all-time PV changed after extend, run ${runs + 1}`);
  }
  assert.ok(runs > 3, `expected the month to take several runs, took ${runs}`);
  assert.ok(runs < 100, "prune never finished");

  // Raw events gone, hot ones untouched.
  assert.equal(Number((await first("SELECT COUNT(*) AS n FROM events_tab WHERE day < ?", cutoff)).n), 0, "expired events left");
  assert.equal(Number((await first("SELECT COUNT(*) AS n FROM events_tab")).n), total - julyTotal, "hot events touched");
  // July survives as exact site_daily_tab rows, one per day, including the day
  // the prune had to seal itself.
  const july = await d1
    .prepare("SELECT day, pv, uv FROM site_daily_tab WHERE day < ? ORDER BY day")
    .bind(cutoff)
    .all();
  assert.deepEqual(
    july.results.map((r) => [Number(r.day), Number(r.pv), Number(r.uv)]),
    [20260729, 20260730, 20260731].map((day) => [day, perDay[day], visitorsPerDay[day].size]),
    "July site_daily_tab rows"
  );
  for (const t of ["dim_daily_tab", "hier_daily_tab"]) {
    const n = await first(`SELECT COUNT(*) AS n FROM ${t} WHERE day < ?`, cutoff);
    assert.equal(Number(n.n), 0, `${t} still holds expired days`);
    const hot = await first(`SELECT COUNT(*) AS n FROM ${t} WHERE day >= ?`, cutoff);
    assert.ok(Number(hot.n) > 0, `${t} lost its hot days`);
  }
  const hotSite = await first("SELECT COUNT(*) AS n FROM site_daily_tab WHERE day >= ?", cutoff);
  assert.equal(Number(hotSite.n), 2, "site_daily_tab lost its hot days");
  assert.equal(Number((await first("SELECT value AS v FROM meta_tab WHERE key = 'prune_agg_month'")).v), 202607);
  assert.equal(Number((await first("SELECT value AS v FROM meta_tab WHERE key = 'rollup_min_day'")).v), 20260801);
  console.log(`  July (${julyTotal} events) pruned over ${runs} runs with a ${budget}-write budget`);

  // Re-running with nothing expired is a no-op.
  await pruneExpiredDays({}, db, today, budget);
  assert.equal(await allTimePv(), total);
}
