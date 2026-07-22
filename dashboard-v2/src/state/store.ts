import { signal, computed } from "@preact/signals";
import type { Dimension, Filter, FilterOp, Metric, Preset } from "../api/types";
import { rangeForPreset } from "./dates";

// --- Configuration (timezone) fetched once at boot ---
export const timezone = signal<string>("Asia/Tokyo");

// --- Core dashboard state ---
export const metric = signal<Metric>("pageviews");
export const preset = signal<Preset>("last7d");
export const customRange = signal<{ from: string; to: string } | null>(null);
export const filters = signal<Filter[]>([]);
export const theme = signal<"light" | "dark">(
  (localStorage.getItem("stats-theme") as "light" | "dark") || "dark"
);

// Detail drawer: which dimension is expanded (null = closed).
export const drawerDimension = signal<Dimension | null>(null);

// Derived time range from the active preset + timezone, or a custom range.
export const timeRange = computed(() =>
  customRange.value
    ? { preset: "custom" as const, ...customRange.value }
    : rangeForPreset(preset.value, timezone.value)
);

// A cache/dependency key that changes whenever the query inputs change.
export const queryKey = computed(() => {
  const r = timeRange.value;
  return JSON.stringify({ m: metric.value, from: r.from, to: r.to, f: filters.value });
});

export function setMetric(m: Metric) {
  metric.value = m;
}

export function setPreset(p: Preset) {
  preset.value = p;
  customRange.value = null;
}

export function setCustomRange(from: string, to: string) {
  customRange.value = { from, to };
}

function sameFilter(a: Filter, b: Filter) {
  return a.dimension === b.dimension && a.op === b.op && a.value === b.value;
}

export function addFilter(dimension: Dimension, op: FilterOp, value: string) {
  const next: Filter = { dimension, op, value };
  // Replace any opposite-op filter on the same dimension+value, and dedupe.
  const kept = filters.value.filter(
    (f) => !(f.dimension === dimension && f.value === value)
  );
  if (filters.value.some((f) => sameFilter(f, next))) {
    filters.value = kept; // toggling the same filter off
  } else {
    filters.value = [...kept, next];
  }
}

export function removeFilter(target: Filter) {
  filters.value = filters.value.filter((f) => !sameFilter(f, target));
}

export function clearFilters() {
  filters.value = [];
}

export function openDrawer(dimension: Dimension) {
  drawerDimension.value = dimension;
}

export function closeDrawer() {
  drawerDimension.value = null;
}

export function toggleTheme() {
  const next = theme.value === "dark" ? "light" : "dark";
  theme.value = next;
  localStorage.setItem("stats-theme", next);
  document.documentElement.dataset.theme = next;
}

// Human-readable labels for dimensions.
export const DIMENSION_LABELS: Record<Dimension, string> = {
  path: "Path",
  referrer_domain: "Referrer",
  country: "Country",
  browser: "Browser",
  browser_version: "Browser version",
  os: "OS",
  os_version: "OS version",
  device_type: "Device type",
  device_vendor: "Device vendor",
  device_model: "Device model",
};

// Default homepage panels.
export const PANEL_DIMENSIONS: Dimension[] = [
  "referrer_domain",
  "path",
  "country",
  "browser",
  "os",
  "device_type",
];

// Dimensions selectable inside the detail drawer. Child dims of a hierarchy
// (browser_version, os_version, device_vendor, device_model) are intentionally
// excluded — they are reached by expanding levels inside a hierarchy root.
export const DRAWER_DIMENSIONS: Dimension[] = [
  "path",
  "referrer_domain",
  "country",
  "browser",
  "os",
  "device_type",
];

// Hierarchical dimensions rendered as a sunburst in the drawer. Each entry maps
// a root dimension to its ordered levels (root first). Levels are fetched via
// client-side fan-out over /api/query, so counts stay exact at every ring.
export const HIERARCHY: Partial<Record<Dimension, Dimension[]>> = {
  device_type: ["device_type", "device_vendor", "device_model"],
  browser: ["browser", "browser_version"],
  os: ["os", "os_version"],
};
