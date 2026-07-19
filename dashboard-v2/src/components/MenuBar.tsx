import { metric, preset, setMetric, setPreset, theme, toggleTheme } from "../state/store";
import { PRESETS } from "../state/dates";
import type { Metric, Preset } from "../api/types";

function MetricSwitcher() {
  const m = metric.value;
  const opt = (id: Metric, label: string) => (
    <button class={m === id ? "active" : ""} onClick={() => setMetric(id)}>
      {label}
    </button>
  );
  return (
    <div class="segmented" role="group" aria-label="Metric">
      {opt("pageviews", "Page Views")}
      {opt("visitors", "Visitors")}
    </div>
  );
}

function TimeRangePicker() {
  const p = preset.value;
  return (
    <div class="segmented" role="group" aria-label="Time range">
      {PRESETS.map((item) => (
        <button class={p === item.id ? "active" : ""} onClick={() => setPreset(item.id as Preset)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function MenuBar() {
  return (
    <div class="menubar">
      <h1>Analytics</h1>
      <MetricSwitcher />
      <TimeRangePicker />
      <button class="btn" onClick={toggleTheme} title="Toggle theme">
        {theme.value === "dark" ? "☀ Light" : "☾ Dark"}
      </button>
    </div>
  );
}
