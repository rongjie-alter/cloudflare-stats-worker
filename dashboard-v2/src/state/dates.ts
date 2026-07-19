import type { Preset, TimeRange } from "../api/types";

// Calendar day in the given IANA timezone as "YYYY-MM-DD".
export function todayInTz(timezone: string, date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function shift(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Resolve a shortcut to inclusive [from, to] bounds in the server timezone.
export function rangeForPreset(preset: Preset, timezone: string): TimeRange {
  const today = todayInTz(timezone);
  switch (preset) {
    case "today":
      return { preset, from: today, to: today };
    case "yesterday": {
      const y = shift(today, -1);
      return { preset, from: y, to: y };
    }
    case "last7d":
      return { preset, from: shift(today, -6), to: today };
    case "last28d":
      return { preset, from: shift(today, -27), to: today };
  }
}

export const PRESETS: { id: Preset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last7d", label: "Last 7 days" },
  { id: "last28d", label: "Last 28 days" },
];
