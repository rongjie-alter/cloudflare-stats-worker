// Palette resolved from CSS variables so charts match the app theme.
export function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => (css.getPropertyValue(name).trim() || fallback);
  const dark = document.documentElement.dataset.theme === "dark";
  return {
    dark,
    text: v("--text", dark ? "#e6e6e6" : "#1a1a1a"),
    muted: v("--muted", dark ? "#9aa4b2" : "#6b7280"),
    accent: v("--accent", "#4f8cff"),
    grid: v("--border", dark ? "#2a3140" : "#e5e7eb"),
    bg: v("--card-bg", dark ? "#141a24" : "#ffffff"),
  };
}

// A distinct-hue categorical series for bar/pie charts.
export const SERIES_COLORS = [
  "#4f8cff",
  "#22c3aa",
  "#f5a524",
  "#f56565",
  "#a78bfa",
  "#38bdf8",
  "#84cc16",
  "#fb7185",
];
