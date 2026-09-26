import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Dimension } from "../../api/types";
import {
  exportMonth,
  fetchManifest,
  getDb,
  importFiles,
  loadServerMonth,
  serverMonths,
  DIMENSIONS,
  type ImportedSource,
  type Manifest,
  type MonthOption,
} from "../../duck/db";
import { breakdown, coverage, totals, trend, type BreakdownRow, type Side, type Totals, type TrendPoint } from "../../duck/mom";
import { compileFilters } from "../../duck/sql";
import { momA, momAdvanced, momAlign, momB, momDimension, momFilters } from "../../state/mom";
import { DIMENSION_LABELS, PANEL_DIMENSIONS } from "../../state/store";
import { daysInMonth, fmtMonth, fmtNum } from "../../utils/format";
import { MomCards } from "./MomCards";
import { MomDeltaTable } from "./MomDeltaTable";
import { MomFilterBar } from "./MomFilterBar";
import { MomTrend } from "./MomTrend";

type Phase = "starting" | "ready" | "error";

interface Result {
  a: Side;
  b: Side;
  totalsA: Totals;
  totalsB: Totals;
  trendA: TrendPoint[];
  trendB: TrendPoint[];
  aligned: number | null; // compared day-of-month cut-off, when aligned
}

function parseKey(key: string): { source: string; month: number } {
  const i = key.lastIndexOf(":");
  return { source: key.slice(0, i), month: Number(key.slice(i + 1)) };
}

export default function MomView() {
  const [phase, setPhase] = useState<Phase>("starting");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Starting DuckDB…");
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [imports, setImports] = useState<ImportedSource[]>([]);
  const [dataVersion, setDataVersion] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [rows, setRows] = useState<BreakdownRow[]>([]);
  const [trendMetric, setTrendMetric] = useState<"pv" | "uv">("pv");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Boot: engine + manifest in parallel.
  useEffect(() => {
    let cancelled = false;
    const t0 = performance.now();
    Promise.all([getDb(), fetchManifest()])
      .then(([, m]) => {
        if (cancelled) return;
        setManifest(m);
        setPhase("ready");
        setStatus(`DuckDB ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      })
      .catch((err) => {
        if (cancelled) return;
        setPhase("error");
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo<MonthOption[]>(() => {
    const out: MonthOption[] = [];
    if (manifest) {
      for (const month of serverMonths(manifest)) {
        out.push({ key: `server:${month}`, source: "server", month, label: fmtMonth(month) });
      }
    }
    for (const imp of imports) {
      for (const month of imp.months) {
        out.push({ key: `${imp.id}:${month}`, source: imp.id, month, label: `${fmtMonth(month)} · ${imp.name}` });
      }
    }
    return out;
  }, [manifest, imports]);

  // Default selection: the latest month with archived data (the live-only
  // month on the 1st would compare against nothing) against the one before it.
  useEffect(() => {
    if (!manifest) return;
    const server = options.filter((o) => o.source === "server");
    const lastDay = manifest.days.at(-1)?.day;
    const latest = lastDay ? Math.floor(Number(lastDay.replace(/-/g, "")) / 100) : server.at(-1)?.month;
    const bIndex = Math.max(0, server.findIndex((o) => o.month === latest));
    if (!momB.value || !options.some((o) => o.key === momB.value)) momB.value = server[bIndex]?.key ?? null;
    if (!momA.value || !options.some((o) => o.key === momA.value)) momA.value = server[bIndex - 1]?.key ?? momB.value;
  }, [options]);

  const selA = momA.value;
  const selB = momB.value;

  // Download whatever the selected server months still need.
  useEffect(() => {
    if (!manifest || !selA || !selB) return;
    const months = [...new Set([selA, selB].map(parseKey).filter((k) => k.source === "server").map((k) => k.month))];
    if (!months.length) return;
    let cancelled = false;
    const t0 = performance.now();
    Promise.all(months.map((m) => loadServerMonth(manifest, m)))
      .then((counts) => {
        if (cancelled) return;
        const files = counts.reduce((s, n) => s + n, 0);
        if (files) setStatus(`Loaded ${files} day file(s) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
        setDataVersion((v) => v + 1);
      })
      .catch((err) => !cancelled && setError(`Loading archive failed: ${err.message ?? err}`));
    return () => {
      cancelled = true;
    };
  }, [manifest, selA, selB]);

  const where = useMemo(() => compileFilters(momFilters.value, momAdvanced.value), [momFilters.value, momAdvanced.value]);
  const align = momAlign.value;
  const dimension = momDimension.value;

  // Headline + trend. Re-runs on any selection/filter change; all in-memory.
  useEffect(() => {
    if (!dataVersion || !selA || !selB) return;
    let cancelled = false;
    (async () => {
      const ka = parseKey(selA);
      const kb = parseKey(selB);
      // A month still in progress only runs to today; compare the same days of
      // the other month. A closed server month counts as complete even with
      // gaps (no data is not "not over yet"). An imported file's month runs to
      // its last day with data -- all we know about it.
      let cut: number | null = null;
      if (align && manifest) {
        const today = Number(manifest.live.to.replace(/-/g, ""));
        const end = async (k: { source: string; month: number }) =>
          k.source === "server"
            ? k.month === Math.floor(today / 100)
              ? today % 100
              : daysInMonth(k.month)
            : (await coverage(k.source, k.month)) || daysInMonth(k.month);
        const [ea, eb] = await Promise.all([end(ka), end(kb)]);
        const full = Math.min(daysInMonth(ka.month), daysInMonth(kb.month));
        if (Math.min(ea, eb) < full) cut = Math.min(ea, eb);
      }
      const side = (k: { source: string; month: number }): Side => ({
        ...k,
        from: k.month * 100 + 1,
        to: k.month * 100 + (cut ?? 31),
      });
      const a = side(ka);
      const b = side(kb);
      const [totalsA, totalsB, trendA, trendB] = await Promise.all([
        totals(a, where),
        totals(b, where),
        trend(a, where),
        trend(b, where),
      ]);
      if (!cancelled) {
        setResult({ a, b, totalsA, totalsB, trendA, trendB, aligned: cut });
        setError(null);
      }
    })().catch((err) => !cancelled && setError(`Query failed: ${err.message ?? err}`));
    return () => {
      cancelled = true;
    };
  }, [dataVersion, selA, selB, where, align, manifest]);

  // Breakdown for the selected dimension.
  useEffect(() => {
    if (!result) return;
    let cancelled = false;
    breakdown(result.a, result.b, dimension, where)
      .then((r) => !cancelled && setRows(r))
      .catch((err) => !cancelled && setError(`Query failed: ${err.message ?? err}`));
    return () => {
      cancelled = true;
    };
  }, [result, dimension]);

  const onFiles = async (list: FileList | File[] | null) => {
    const files = [...(list ?? [])].filter((f) => f.name.toLowerCase().endsWith(".parquet"));
    if (!files.length) return;
    setStatus(`Importing ${files.length} file(s)…`);
    try {
      await getDb();
      const imp = await importFiles(files);
      setImports((prev) => [...prev, imp]);
      setStatus(`Imported ${fmtNum(imp.rows)} pageviews from ${imp.name}`);
      if (imp.months.length) momB.value = `${imp.id}:${imp.months.at(-1)}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onExport = async (key: string | null) => {
    if (!key) return;
    const { source, month } = parseKey(key);
    const m = String(month);
    setStatus(`Exporting ${fmtMonth(month)}…`);
    try {
      await exportMonth(source, month, `stats-${m.slice(0, 4)}-${m.slice(4)}.parquet`);
      setStatus(`Exported ${fmtMonth(month)}`);
    } catch (err) {
      setError(`Export failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const onRefresh = async () => {
    try {
      const m = await fetchManifest();
      setManifest(m);
      const months = [selA, selB].filter(Boolean).map((k) => parseKey(k!)).filter((k) => k.source === "server");
      await Promise.all(months.map((k) => loadServerMonth(m, k.month, { refreshLive: true })));
      setDataVersion((v) => v + 1);
      setStatus("Refreshed");
    } catch (err) {
      setError(`Refresh failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  if (phase === "starting") return <div class="live-message">Starting DuckDB…</div>;
  if (phase === "error") return <div class="live-message">Month-over-Month is unavailable: {error}</div>;

  const labelOf = (key: string | null) => options.find((o) => o.key === key)?.label.split(" · ")[0] ?? "—";
  const labelA = labelOf(selA);
  const labelB = labelOf(selB);
  const picker = (value: string | null, set: (v: string) => void, title: string) => (
    <label class="mom-pick">
      <span class="muted">{title}</span>
      <select class="dim-select" value={value ?? ""} onChange={(e) => set((e.target as HTMLSelectElement).value)}>
        {options.map((o) => (
          <option value={o.key}>{o.label}</option>
        ))}
      </select>
      <button class="btn mom-icon" title={`Download ${labelOf(value)} as Parquet`} onClick={() => onExport(value)}>
        ⬇
      </button>
    </label>
  );

  return (
    <div
      class={`mom${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        onFiles(e.dataTransfer?.files ?? null);
      }}
    >
      <div class="mom-toolbar">
        {picker(selA, (v) => (momA.value = v), "Baseline")}
        <span class="muted">vs</span>
        {picker(selB, (v) => (momB.value = v), "Compare")}
        <label class="mom-check" title="Compare the same day range when a month is only partly covered">
          <input type="checkbox" checked={align} onChange={(e) => (momAlign.value = (e.target as HTMLInputElement).checked)} />
          Align days
        </label>
        <span class="spacer" />
        <button class="btn" onClick={() => fileInput.current?.click()} title="Import exported .parquet files (or drop them here)">
          Import…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".parquet"
          multiple
          hidden
          onChange={(e) => {
            const input = e.target as HTMLInputElement;
            onFiles(input.files);
            input.value = "";
          }}
        />
        <button class="btn" onClick={onRefresh} title="Re-fetch the manifest and today's live data">
          ↻
        </button>
      </div>

      <div class="mom-status muted">
        {status}
        {result?.aligned ? ` · comparing days 1–${result.aligned} of each month` : ""}
        {" · all filtering runs in your browser (0 D1 reads)"}
      </div>
      {error && <div class="mom-error">{error}</div>}

      <MomFilterBar dataVersion={dataVersion} />

      {!options.length && <div class="live-message">Nothing archived yet. The nightly cron writes one file per closed day.</div>}

      {result && (
        <>
          <MomCards a={result.totalsA} b={result.totalsB} labelA={labelA} labelB={labelB} />
          <div class="chart-card">
            <div class="panel-head">
              <h3>Daily trend</h3>
              <div class="segmented" role="group" aria-label="Trend metric">
                <button class={trendMetric === "pv" ? "active" : ""} onClick={() => setTrendMetric("pv")}>
                  Page Views
                </button>
                <button class={trendMetric === "uv" ? "active" : ""} onClick={() => setTrendMetric("uv")}>
                  Visitors
                </button>
              </div>
            </div>
            <MomTrend
              a={result.trendA}
              b={result.trendB}
              labelA={labelA}
              labelB={labelB}
              metric={trendMetric}
              days={result.aligned ?? Math.max(daysInMonth(result.a.month), daysInMonth(result.b.month))}
            />
          </div>
          <div class="chart-card">
            <div class="panel-head">
              <h3>Breakdown</h3>
              <select
                class="dim-select"
                value={dimension}
                onChange={(e) => (momDimension.value = (e.target as HTMLSelectElement).value as Dimension)}
              >
                {[...PANEL_DIMENSIONS, ...DIMENSIONS.filter((d) => !PANEL_DIMENSIONS.includes(d))].map((d) => (
                  <option value={d}>{DIMENSION_LABELS[d]}</option>
                ))}
              </select>
            </div>
            <MomDeltaTable dimension={dimension} rows={rows} labelA={labelA} labelB={labelB} />
          </div>
        </>
      )}
    </div>
  );
}
