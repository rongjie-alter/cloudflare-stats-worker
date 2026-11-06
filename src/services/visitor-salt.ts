// Visitor ids hashed with a salt that is random per LOCAL day and deleted by the
// nightly cron.
//
// Why: `SHA-256(ip|ua)` gave a person the same id on every day -- a long-lived
// pseudonymous identifier, and one whose IP could be brute-forced back out of the
// stored value (the IPv4 space is tiny). With a per-day random salt that is
// destroyed after the day closes, stored ids cannot be reversed to an IP and
// cannot be linked across days. The price is that a distinct count over several
// days is no longer "people": UV is a per-day metric, and wider ranges report
// avg/min/max of the daily figures.
//
// The salt is keyed by the same local `day` that is written to events_tab.day, not
// by UTC. A boundary that differed from the day boundary would split one reported
// day across two id spaces and inflate its UV.
//
// Storage is meta_tab (`visitor_salt:YYYYMMDD`), so there is no migration. Cost:
// one read per cold isolate per day, one written row per day account-wide.
import { eq } from "drizzle-orm";
import { metaTab } from "../db/schema.ts";
import type { Db } from "../db/client.ts";

export const VISITOR_SALT_PREFIX = "visitor_salt:";

interface CachedSalt {
  day: number;
  key: CryptoKey;
}

// Isolate-global. Reused only while the day matches, so the rollover at local
// midnight picks up the new salt with no timer.
let cached: CachedSalt | null = null;

function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function importSalt(salt: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

// Get-or-create the salt for `day`. Same shape as getDimId: SELECT, then
// INSERT ... DO NOTHING, then SELECT again, so concurrent isolates converge on one
// salt and the steady state is read-only.
async function loadSalt(db: Db, day: number): Promise<string> {
  const key = `${VISITOR_SALT_PREFIX}${day}`;
  const find = () => db.select({ value: metaTab.value }).from(metaTab).where(eq(metaTab.key, key)).get();
  let row = await find();
  if (!row) {
    await db.insert(metaTab).values({ key, value: randomSalt() }).onConflictDoNothing({ target: metaTab.key });
    row = await find();
  }
  if (!row) throw new Error("visitor salt missing after insert");
  return row.value;
}

// The HMAC key for `day`.
//
// Fails SAFE: if D1 cannot be read or written, an isolate-local random salt is
// used for the day. A D1 outage then costs UV accuracy (the same person can get
// different ids in different isolates) but never privacy, and never drops a
// pageview. It must not fall back to an unsalted hash.
async function getDailyKey(db: Db, day: number): Promise<CryptoKey> {
  if (cached && cached.day === day) return cached.key;
  let salt: string;
  try {
    salt = await loadSalt(db, day);
  } catch (err) {
    console.error("[worker] visitor salt unavailable, using an isolate-local salt", err);
    salt = randomSalt();
  }
  const key = await importSalt(salt);
  cached = { day, key };
  return key;
}

// 52-bit id (first 13 hex digits), so events_tab.visitor_id and the Parquet
// schema are unchanged.
export async function visitorIdFor(db: Db, day: number, ip: string, userAgent: string): Promise<number> {
  const key = await getDailyKey(db, day);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ip}|${userAgent}`));
  const bytes = new Uint8Array(mac);
  let hex = "";
  for (let i = 0; i < 7; i += 1) hex += bytes[i].toString(16).padStart(2, "0");
  return parseInt(hex.slice(0, 13), 16);
}

// Run by the nightly cron (00:30 local): everything older than today goes. Nothing
// needs a past salt -- ids are hashed at ingest -- so a salt lives about 24.5 h.
// 'visitor_salt:' + an 8-digit day sorts correctly as text, so this is a plain
// primary-key range: no LIKE (whose `_` is a wildcard, and which cannot use the
// index), and every key in [prefix, prefix + today) starts with the prefix.
export async function purgeVisitorSalts(db: Db, today: number): Promise<void> {
  await db.$client
    .prepare("DELETE FROM meta_tab WHERE key >= ? AND key < ?")
    .bind(VISITOR_SALT_PREFIX, `${VISITOR_SALT_PREFIX}${today}`)
    .run();
  // A stale in-isolate key for a past day is harmless: it is only used for that day.
}
