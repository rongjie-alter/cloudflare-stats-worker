#!/usr/bin/env node
// Quick read-only check against a live V2 deployment: node check.js
// Override target with STATS_HOST=https://stats.example.com node check.js
import { setTimeout as delay } from "node:timers/promises";

const HOST = process.env.STATS_HOST || "http://127.0.0.1:8787";
const paths = [
  "/health",
  "/api/config",
  "/api/summary",
  "/api/timeseries?metric=pageviews",
  "/api/query?metric=pageviews&group_by=country",
  "/api/query?metric=visitors&group_by=browser",
  "/api/query?metric=pageviews&group_by=referrer_domain",
];

async function fetchJson(path) {
  const url = new URL(path, HOST);
  url.searchParams.set("t", Date.now().toString());
  const res = await fetch(url, { headers: { "User-Agent": "stats-check/2.0" } });
  if (!res.ok) throw new Error(`${url.href} -> HTTP ${res.status}`);
  return res.json();
}

function formatSection(title) {
  const line = "-".repeat(title.length + 4);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

(async () => {
  console.log(`Cloudflare Stats Worker V2 quick check (target: ${HOST})`);
  for (const path of paths) {
    formatSection(path);
    try {
      console.dir(await fetchJson(path), { depth: null, colors: true });
    } catch (error) {
      console.error("  x error:", error.message);
    }
    await delay(150);
  }
  console.log("\nDone.");
})();
