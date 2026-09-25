import { useEffect, useMemo, useRef } from "preact/hooks";
import { createGrid } from "ag-grid-community";
import type { ColDef, GridApi, GridOptions } from "ag-grid-community";
import { gridTheme } from "../../grid/agGridSetup";
import type { Dimension } from "../../api/types";
import type { BreakdownRow } from "../../duck/mom";
import { toggleRowFilter } from "../../state/mom";
import { DIMENSION_LABELS, theme } from "../../state/store";
import { countryName } from "../../utils/countryName";
import { fmtChange } from "../../utils/format";

interface DeltaRow extends BreakdownRow {
  delta: number;
  change: number | null; // relative change; null when A is 0
  shareA: number;
  shareB: number;
  shareDelta: number; // percentage points
}

const num = (v: number | null | undefined) => (v ?? 0).toLocaleString();
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const signCls = (v: number | null | undefined) => (v == null || v === 0 ? "" : v > 0 ? "mom-up" : "mom-down");

// Every value of one dimension with both months side by side. Sort by Δ to
// find the biggest gainers and losers; share Δ shows mix shifts that raw
// counts hide when total traffic moves.
export function MomDeltaTable({
  dimension,
  rows,
  labelA,
  labelB,
}: {
  dimension: Dimension;
  rows: BreakdownRow[];
  labelA: string;
  labelB: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<GridApi<DeltaRow> | null>(null);
  const themeVal = theme.value;

  const data = useMemo<DeltaRow[]>(() => {
    const totA = rows.reduce((s, r) => s + r.pvA, 0) || 1;
    const totB = rows.reduce((s, r) => s + r.pvB, 0) || 1;
    return rows.map((r) => ({
      ...r,
      delta: r.pvB - r.pvA,
      change: r.pvA ? (r.pvB - r.pvA) / r.pvA : null,
      shareA: r.pvA / totA,
      shareB: r.pvB / totB,
      shareDelta: (r.pvB / totB - r.pvA / totA) * 100,
    }));
  }, [rows]);

  useEffect(() => {
    if (!el.current) return;
    const columnDefs: ColDef<DeltaRow>[] = [
      {
        headerName: DIMENSION_LABELS[dimension],
        field: "key",
        flex: 2,
        minWidth: 160,
        filter: true,
        pinned: "left",
        ...(dimension === "country" && { valueFormatter: (p) => countryName(p.value) }),
      },
      { headerName: `PV ${labelA}`, field: "pvA", width: 110, valueFormatter: (p) => num(p.value) },
      { headerName: `PV ${labelB}`, field: "pvB", width: 110, valueFormatter: (p) => num(p.value) },
      {
        headerName: "Δ PV",
        field: "delta",
        width: 100,
        valueFormatter: (p) => (p.value > 0 ? `+${num(p.value)}` : num(p.value)),
        cellClass: (p) => signCls(p.value),
      },
      {
        headerName: "Δ %",
        field: "change",
        width: 90,
        valueFormatter: (p) => (p.data ? fmtChange(p.data.pvA, p.data.pvB) : ""),
        cellClass: (p) => signCls(p.data ? p.data.delta : 0),
      },
      { headerName: `Share ${labelA}`, field: "shareA", width: 100, valueFormatter: (p) => pct(p.value) },
      { headerName: `Share ${labelB}`, field: "shareB", width: 100, valueFormatter: (p) => pct(p.value) },
      {
        headerName: "Share Δ",
        field: "shareDelta",
        width: 95,
        valueFormatter: (p) => `${p.value > 0 ? "+" : ""}${p.value.toFixed(1)}pp`,
        cellClass: (p) => signCls(Math.round(p.value * 10)),
      },
      { headerName: `UV ${labelA}`, field: "uvA", width: 100, valueFormatter: (p) => num(p.value) },
      { headerName: `UV ${labelB}`, field: "uvB", width: 100, valueFormatter: (p) => num(p.value) },
      {
        headerName: "",
        width: 130,
        sortable: false,
        filter: false,
        cellRenderer: (p: any) => {
          const wrap = document.createElement("div");
          const mk = (label: string, op: "include" | "exclude") => {
            const b = document.createElement("button");
            b.textContent = label;
            b.className = "btn";
            b.style.cssText = "margin-right:4px;cursor:pointer;font-size:11px;padding:1px 6px;";
            b.onclick = () => toggleRowFilter(dimension, op, p.data.key);
            return b;
          };
          wrap.appendChild(mk("Filter", "include"));
          wrap.appendChild(mk("Exclude", "exclude"));
          return wrap;
        },
      },
    ];
    const options: GridOptions<DeltaRow> = {
      theme: gridTheme(theme.value),
      columnDefs,
      defaultColDef: { resizable: true, sortable: true },
      rowData: data,
      pagination: true,
      paginationPageSize: 20,
    };
    api.current = createGrid(el.current, options);
    return () => {
      api.current?.destroy();
      api.current = null;
    };
  }, [dimension, labelA, labelB]);

  useEffect(() => {
    api.current?.setGridOption("rowData", data);
  }, [data]);

  useEffect(() => {
    api.current?.setGridOption("theme", gridTheme(themeVal));
  }, [themeVal]);

  return <div ref={el} class="grid-wrap mom-grid" />;
}
