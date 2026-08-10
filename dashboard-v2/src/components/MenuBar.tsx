import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { customRange, metric, preset, setCustomRange, setMetric, setPreset, setView, theme, timeRange, toggleTheme, view } from "../state/store";
import { PRESETS } from "../state/dates";
import type { Metric, Preset } from "../api/types";

function fmtDate(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const isValidDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// How long to wait after the last keystroke before applying a custom range.
const RANGE_COMMIT_DELAY_MS = 400;

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
  const open = useSignal(false);
  const ref = useRef<HTMLDivElement>(null);
  const fromVal = useSignal(timeRange.value.from);
  const toVal = useSignal(timeRange.value.to);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (commitTimer.current !== null) clearTimeout(commitTimer.current);
  }, []);

  useEffect(() => {
    if (!open.value) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        open.value = false;
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open.value]);

  const cr = customRange.value;
  const triggerLabel = cr
    ? `${fmtDate(cr.from)} – ${fmtDate(cr.to)}`
    : (PRESETS.find((p) => p.id === preset.value)?.label ?? "Custom");

  const handleToggle = () => {
    if (!open.value) {
      fromVal.value = timeRange.value.from;
      toVal.value = timeRange.value.to;
    }
    open.value = !open.value;
  };

  const handleShortcut = (id: Preset) => {
    setPreset(id);
    fromVal.value = timeRange.value.from;
    toVal.value = timeRange.value.to;
  };

  // Typing a year into <input type="date"> emits a valid-looking value on every
  // keystroke -- "0002-…", "0020-…", "0202-…", "2026-…" -- and each one used to
  // fire a full dashboard refresh immediately. Debouncing collapses that to one.
  const commit = (from: string, to: string) => {
    if (!isValidDate(from) || !isValidDate(to)) return;
    if (commitTimer.current !== null) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      commitTimer.current = null;
      setCustomRange(from, to);
    }, RANGE_COMMIT_DELAY_MS);
  };

  const handleFromInput = (e: Event) => {
    const val = (e.target as HTMLInputElement).value;
    fromVal.value = val;
    commit(val, toVal.value);
  };

  const handleToInput = (e: Event) => {
    const val = (e.target as HTMLInputElement).value;
    toVal.value = val;
    commit(fromVal.value, val);
  };

  return (
    <div class="date-picker-wrap" ref={ref}>
      <button class="btn date-picker-btn" onClick={handleToggle}>
        {triggerLabel} ▾
      </button>
      {open.value && (
        <div class="date-picker-popup">
          <div class="date-picker-shortcuts">
            {PRESETS.map((item) => (
              <button
                class={!cr && preset.value === item.id ? "active" : ""}
                onClick={() => handleShortcut(item.id as Preset)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <hr class="date-picker-divider" />
          <div class="date-picker-inputs">
            <label>
              From
              <input type="date" value={fromVal.value} onInput={handleFromInput} />
            </label>
            <span class="date-sep">–</span>
            <label>
              To
              <input type="date" value={toVal.value} onInput={handleToInput} />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

function ViewSwitcher() {
  const v = view.value;
  return (
    <div class="segmented" role="group" aria-label="View">
      <button class={v === "history" ? "active" : ""} onClick={() => setView("history")}>
        History
      </button>
      <button class={v === "live" ? "active" : ""} onClick={() => setView("live")}>
        Live
      </button>
    </div>
  );
}

export function MenuBar() {
  const isLive = view.value === "live";
  return (
    <div class="menubar">
      <h1>Analytics</h1>
      <ViewSwitcher />
      {!isLive && <MetricSwitcher />}
      {!isLive && <TimeRangePicker />}
      <button class="btn" onClick={toggleTheme} title="Toggle theme">
        {theme.value === "dark" ? "☀ Light" : "☾ Dark"}
      </button>
    </div>
  );
}
