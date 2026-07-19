import { useEffect, useRef } from "preact/hooks";
import { createGrid } from "ag-grid-community";
import type { GridApi, GridOptions } from "ag-grid-community";
import { gridTheme } from "../grid/agGridSetup";
import { echarts } from "../charts/echarts";
import { palette, SERIES_COLORS } from "../charts/theme";
import { CountryMap } from "./CountryMap";
import { useAggregate } from "../hooks";
import {
  addFilter,
  closeDrawer,
  drawerDimension,
  metric,
  openDrawer,
  theme,
  DIMENSION_LABELS,
  DRAWER_DIMENSIONS,
} from "../state/store";
import type { AggregateRow, Dimension } from "../api/types";

function DetailChart({ rows }: { rows: AggregateRow[] }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ReturnType<typeof echarts.init> | null>(null);
  const themeVal = theme.value;

  useEffect(() => {
    if (!el.current) return;
    chart.current = echarts.init(el.current);
    const onResize = () => chart.current?.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chart.current) return;
    const p = palette();
    const top = rows.slice(0, 12).reverse();
    chart.current.setOption(
      {
        grid: { left: 8, right: 24, top: 10, bottom: 10, containLabel: true },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
        xAxis: { type: "value", splitLine: { lineStyle: { color: p.grid } }, axisLabel: { color: p.muted } },
        yAxis: {
          type: "category",
          data: top.map((r) => r.key),
          axisLabel: { color: p.muted, width: 160, overflow: "truncate" },
          axisLine: { lineStyle: { color: p.grid } },
        },
        series: [
          {
            type: "bar",
            data: top.map((r) => r.value),
            itemStyle: { color: SERIES_COLORS[0], borderRadius: [0, 4, 4, 0] },
          },
        ],
      },
      true
    );
  }, [rows, themeVal]);

  return <div ref={el} style="width:100%;height:360px;" />;
}

function DetailGrid({ dimension, rows }: { dimension: Dimension; rows: AggregateRow[] }) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<GridApi | null>(null);
  const themeVal = theme.value;
  const metricLabel = metric.value === "visitors" ? "Visitors" : "Page Views";

  useEffect(() => {
    if (!el.current) return;
    const options: GridOptions<AggregateRow> = {
      theme: gridTheme(theme.value),
      columnDefs: [
        { headerName: DIMENSION_LABELS[dimension], field: "key", flex: 2, filter: true, sortable: true },
        {
          headerName: metricLabel,
          field: "value",
          flex: 1,
          sortable: true,
          sort: "desc",
          valueFormatter: (p) => (p.value ?? 0).toLocaleString(),
        },
        {
          headerName: "",
          width: 130,
          sortable: false,
          filter: false,
          cellRenderer: (p: any) => {
            const wrap = document.createElement("div");
            const mk = (label: string, op: "include" | "exclude", cls: string) => {
              const b = document.createElement("button");
              b.textContent = label;
              b.className = cls;
              b.style.cssText = "margin-right:4px;cursor:pointer;font-size:11px;padding:1px 6px;";
              b.onclick = () => addFilter(dimension, op, p.data.key);
              return b;
            };
            wrap.appendChild(mk("Filter", "include", "btn"));
            wrap.appendChild(mk("Exclude", "exclude", "btn"));
            return wrap;
          },
        },
      ],
      defaultColDef: { resizable: true },
      rowData: rows,
      pagination: true,
      paginationPageSize: 20,
    };
    api.current = createGrid(el.current, options);
    return () => {
      api.current?.destroy();
      api.current = null;
    };
  }, [dimension]);

  useEffect(() => {
    api.current?.setGridOption("rowData", rows);
  }, [rows]);

  useEffect(() => {
    api.current?.setGridOption("theme", gridTheme(themeVal));
  }, [themeVal]);

  return <div class="grid-wrap" ref={el} />;
}

export default function DetailDrawer() {
  const dimension = drawerDimension.value;
  if (!dimension) return null;
  return <DrawerBody dimension={dimension} />;
}

function DrawerBody({ dimension }: { dimension: Dimension }) {
  const { data, loading } = useAggregate(dimension, 500);
  const rows = data?.results ?? [];
  const metricLabel = metric.value === "visitors" ? "Visitors" : "Page Views";

  return (
    <>
      <div class="drawer-backdrop" onClick={closeDrawer} />
      <div class="drawer" role="dialog" aria-modal="true">
        <div class="drawer-head">
          <h2>{DIMENSION_LABELS[dimension]}</h2>
          <select
            class="dim-select"
            value={dimension}
            onChange={(e) => openDrawer((e.target as HTMLSelectElement).value as Dimension)}
          >
            {DRAWER_DIMENSIONS.map((d) => (
              <option value={d}>{DIMENSION_LABELS[d]}</option>
            ))}
          </select>
          <button class="btn" onClick={closeDrawer}>
            Close
          </button>
        </div>

        {loading && <div class="loading">Loading…</div>}

        {dimension === "country" ? (
          <CountryMap rows={rows} metricLabel={metricLabel} />
        ) : (
          <DetailChart rows={rows} />
        )}

        <DetailGrid dimension={dimension} rows={rows} />
      </div>
    </>
  );
}
