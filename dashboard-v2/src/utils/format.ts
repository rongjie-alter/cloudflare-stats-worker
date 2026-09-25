export function fmtNum(n: number): string {
  return n.toLocaleString();
}

// Relative change a -> b, e.g. "+12.3%"; "new" when there is no baseline.
export function fmtChange(a: number, b: number): string {
  if (a === 0) return b === 0 ? "0%" : "new";
  const pct = ((b - a) / a) * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

export function fmtSigned(n: number, digits = 0): string {
  const s = n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
  return n > 0 ? `+${s}` : s;
}

// yyyymm -> "Aug 2026"
export function fmtMonth(month: number): string {
  const d = new Date(Date.UTC(Math.floor(month / 100), (month % 100) - 1, 1));
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function daysInMonth(month: number): number {
  return new Date(Date.UTC(Math.floor(month / 100), month % 100, 0)).getUTCDate();
}
