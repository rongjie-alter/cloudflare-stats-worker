import { useEffect, useRef, useState } from "preact/hooks";
import { createGrid } from "ag-grid-community";
import type { GridApi, GridOptions, ColDef } from "ag-grid-community";
import { gridTheme } from "../grid/agGridSetup";
import { echarts } from "../charts/echarts";
import { palette, SERIES_COLORS } from "../charts/theme";
import { CountryMap } from "./CountryMap";
import { useAggregate, useHierarchy } from "../hooks";
import {
  addFilter,
  closeDrawer,
  drawerDimension,
  metric,
  openDrawer,
  theme,
  DIMENSION_LABELS,
  DRAWER_DIMENSIONS,
  HIERARCHY,
} from "../state/store";
import { countryName } from "../utils/countryName";
import type { AggregateRow, Dimension, HierarchyNode } from "../api/types";

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

const PARENT_DIM: Partial<Record<Dimension, Dimension>> = {
  browser_version: "browser",
  os_version: "os",
};

function DetailGrid({ dimension, rows }: { dimension: Dimension; rows: AggregateRow[] }) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<GridApi | null>(null);
  const themeVal = theme.value;
  const metricLabel = metric.value === "visitors" ? "Visitors" : "Page Views";

  useEffect(() => {
    if (!el.current) return;
    const parentDim = PARENT_DIM[dimension] as Dimension | undefined;
    const columnDefs: ColDef<AggregateRow>[] = [
      ...(parentDim
        ? [{ headerName: DIMENSION_LABELS[parentDim], field: "parent" as const, flex: 1, filter: true, sortable: true }]
        : []),
      {
        headerName: DIMENSION_LABELS[dimension],
        field: "key" as const,
        flex: 2,
        filter: true,
        sortable: true,
        ...(dimension === "country" && { valueFormatter: (p) => countryName(p.value) }),
      },
      {
        headerName: metricLabel,
        field: "value" as const,
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
    ];

    const options: GridOptions<AggregateRow> = {
      theme: gridTheme(theme.value),
      columnDefs,
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

// --- Hierarchy (sunburst) view ------------------------------------------------

function toSunburst(nodes: HierarchyNode[]): any[] {
  return nodes.map((n) => ({
    name: n.key,
    value: n.value,
    ...(n.children && n.children.length ? { children: toSunburst(n.children) } : {}),
  }));
}

function HierarchySunburst({ tree, metricLabel }: { tree: HierarchyNode[]; metricLabel: string }) {
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
    chart.current.setOption(
      {
        color: SERIES_COLORS,
        tooltip: {
          trigger: "item",
          formatter: (params: any) => {
            const info = params.treePathInfo || [];
            const path = info.slice(1).map((t: any) => t.name).join(" › ");
            const total = info[0]?.value ?? 0;
            const value = params.value ?? 0;
            const pct = total > 0 ? ` (${((value / total) * 100).toFixed(1)}%)` : "";
            return `${path}<br/><b>${value.toLocaleString()}</b> ${metricLabel}${pct}`;
          },
        },
        series: [
          {
            type: "sunburst",
            radius: [0, "95%"],
            data: toSunburst(tree),
            emphasis: { focus: "ancestor" },
            itemStyle: { borderColor: p.bg, borderWidth: 2 },
            label: { color: "#fff", minAngle: 8 },
          },
        ],
      },
      true
    );
  }, [tree, themeVal, metricLabel]);

  return <div ref={el} style="width:100%;height:360px;" />;
}

interface LeafRow {
  path: string[];
  value: number;
}

function flattenLeaves(nodes: HierarchyNode[], prefix: string[] = []): LeafRow[] {
  const out: LeafRow[] = [];
  for (const n of nodes) {
    const path = [...prefix, n.key];
    if (n.children && n.children.length) out.push(...flattenLeaves(n.children, path));
    else out.push({ path, value: n.value });
  }
  return out;
}

function HierarchyGrid({ levels, tree }: { levels: Dimension[]; tree: HierarchyNode[] }) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<GridApi | null>(null);
  const themeVal = theme.value;
  const metricVal = metric.value;
  const metricLabel = metricVal === "visitors" ? "Visitors" : "Page Views";
  const levelsKey = levels.join(">");
  const rows = flattenLeaves(tree);

  useEffect(() => {
    if (!el.current) return;
    const deepest = levels[levels.length - 1];
    const columnDefs: ColDef<LeafRow>[] = [
      ...levels.map((dim, i) => ({
        headerName: DIMENSION_LABELS[dim],
        valueGetter: (p: any) =>
          dim === "country" ? countryName(p.data?.path[i]) : p.data?.path[i],
        flex: 1,
        filter: true,
        sortable: true,
      })),
      {
        headerName: metricLabel,
        field: "value" as const,
        flex: 1,
        sortable: true,
        sort: "desc" as const,
        valueFormatter: (p) => (p.value ?? 0).toLocaleString(),
      },
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
            b.onclick = () => addFilter(deepest, op, p.data.path[p.data.path.length - 1]);
            return b;
          };
          wrap.appendChild(mk("Filter", "include"));
          wrap.appendChild(mk("Exclude", "exclude"));
          return wrap;
        },
      },
    ];

    const options: GridOptions<LeafRow> = {
      theme: gridTheme(theme.value),
      columnDefs,
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
    // Rebuild when the active levels or the metric (column header/sort) change.
  }, [levelsKey, metricVal]);

  useEffect(() => {
    api.current?.setGridOption("rowData", rows);
  }, [tree]);

  useEffect(() => {
    api.current?.setGridOption("theme", gridTheme(themeVal));
  }, [themeVal]);

  return <div class="grid-wrap" ref={el} />;
}

function HierarchyView({ dimension }: { dimension: Dimension }) {
  const allLevels = HIERARCHY[dimension]!;
  const [depth, setDepth] = useState(1);
  // Reset to top-level only when the root dimension changes.
  useEffect(() => setDepth(1), [dimension]);
  const levels = allLevels.slice(0, depth);
  const { data, loading } = useHierarchy(levels);
  const tree = data ?? [];
  const metricLabel = metric.value === "visitors" ? "Visitors" : "Page Views";

  return (
    <>
      <div class="level-control">
        {allLevels.map((dim, i) => {
          const active = i < depth;
          const isRoot = i === 0;
          return (
            <button
              class={`level-chip${active ? " active" : ""}`}
              disabled={isRoot}
              title={isRoot ? "Top level" : active ? "Remove this level" : "Add this level"}
              onClick={() => setDepth(active ? i : i + 1)}
            >
              {!active && !isRoot ? "+ " : ""}
              {DIMENSION_LABELS[dim]}
            </button>
          );
        })}
      </div>

      {loading && <div class="loading">Loading…</div>}

      <HierarchySunburst tree={tree} metricLabel={metricLabel} />
      <HierarchyGrid levels={levels} tree={tree} />
    </>
  );
}

// --- Flat (bar / map) view ----------------------------------------------------

function FlatBody({ dimension }: { dimension: Dimension }) {
  const { data, loading } = useAggregate(dimension, 500);
  const rows = data?.results ?? [];
  const metricLabel = metric.value === "visitors" ? "Visitors" : "Page Views";

  return (
    <>
      {loading && <div class="loading">Loading…</div>}

      {dimension === "country" ? (
        <CountryMap rows={rows} metricLabel={metricLabel} />
      ) : (
        <DetailChart rows={rows} />
      )}

      <DetailGrid dimension={dimension} rows={rows} />
    </>
  );
}

export default function DetailDrawer() {
  const dimension = drawerDimension.value;
  if (!dimension) return null;
  return <DrawerBody dimension={dimension} />;
}

function DrawerBody({ dimension }: { dimension: Dimension }) {
  const isHierarchy = dimension in HIERARCHY;

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

        {isHierarchy ? <HierarchyView dimension={dimension} /> : <FlatBody dimension={dimension} />}
      </div>
    </>
  );
}
