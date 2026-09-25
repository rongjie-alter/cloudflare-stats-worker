// State for the Month-over-Month view. Kept apart from store.ts: these
// filters are richer than the History view's, and they apply to the two
// months loaded into DuckDB rather than to D1 queries.
import { signal } from "@preact/signals";
import type { Dimension } from "../api/types";
import type { MatchOp, MomFilter } from "../duck/sql";

// Month selections, as MonthOption keys (`${source}:${yyyymm}`). A is the
// baseline (normally the earlier month), B the month being judged against it.
export const momA = signal<string | null>(null);
export const momB = signal<string | null>(null);
export const momFilters = signal<MomFilter[]>([]);
export const momAdvanced = signal<string>("");
// When a month is still in progress (the current month, or an imported file
// that stops early), compare the same day-of-month range in both.
export const momAlign = signal<boolean>(true);
export const momDimension = signal<Dimension>("path");

let nextId = 1;

export function addMomFilter(dimension: Dimension, op: "include" | "exclude", match: MatchOp, values: string[]) {
  const clean = values.map((v) => v.trim()).filter(Boolean);
  if (!clean.length) return;
  momFilters.value = [...momFilters.value, { id: nextId++, dimension, op, match, values: clean }];
}

// From a table row: an exact-match filter, toggled off if it already exists,
// and replacing the opposite op for the same value (as addFilter() does).
export function toggleRowFilter(dimension: Dimension, op: "include" | "exclude", value: string) {
  const same = (f: MomFilter) => f.dimension === dimension && f.match === "equals" && f.values.length === 1 && f.values[0] === value;
  const existing = momFilters.value.find(same);
  const kept = momFilters.value.filter((f) => !same(f));
  momFilters.value = existing?.op === op ? kept : [...kept, { id: nextId++, dimension, op, match: "equals", values: [value] }];
}

export function removeMomFilter(id: number) {
  momFilters.value = momFilters.value.filter((f) => f.id !== id);
}

export function clearMomFilters() {
  momFilters.value = [];
  momAdvanced.value = "";
}
