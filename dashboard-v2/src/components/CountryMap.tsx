import { useEffect, useRef, useState } from "preact/hooks";
import { echarts, ensureWorldMap } from "../charts/echarts";
import { palette } from "../charts/theme";
import { addFilter, theme } from "../state/store";
import type { AggregateRow } from "../api/types";

export function CountryMap({ rows, metricLabel }: { rows: AggregateRow[]; metricLabel: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ReturnType<typeof echarts.init> | null>(null);
  const [ready, setReady] = useState(false);
  const themeVal = theme.value;

  useEffect(() => {
    let disposed = false;
    ensureWorldMap().then(() => {
      if (disposed || !el.current) return;
      chart.current = echarts.init(el.current);
      chart.current.on("click", (params: any) => {
        if (params.name) addFilter("country", "include", params.name);
      });
      const onResize = () => chart.current?.resize();
      window.addEventListener("resize", onResize);
      setReady(true);
      (chart.current as any).__onResize = onResize;
    });
    return () => {
      disposed = true;
      if (chart.current) {
        window.removeEventListener("resize", (chart.current as any).__onResize);
        chart.current.dispose();
        chart.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!ready || !chart.current) return;
    const p = palette();
    const max = rows.reduce((m, r) => Math.max(m, r.value), 0) || 1;
    chart.current.setOption(
      {
        tooltip: { trigger: "item", formatter: (o: any) => `${o.name}: ${o.value || 0}` },
        visualMap: {
          min: 0,
          max,
          left: 12,
          bottom: 12,
          text: ["High", "Low"],
          calculable: true,
          inRange: { color: p.dark ? ["#1b2836", "#4f8cff"] : ["#e6efff", "#2563eb"] },
          textStyle: { color: p.muted },
        },
        series: [
          {
            name: metricLabel,
            type: "map",
            map: "world",
            nameProperty: "ISO_A2_EH",
            roam: true,
            itemStyle: { borderColor: p.grid, areaColor: p.bg },
            emphasis: { label: { show: false }, itemStyle: { areaColor: p.accent } },
            data: rows.map((r) => ({ name: r.key, value: r.value })),
          },
        ],
      },
      true
    );
  }, [ready, rows, themeVal, metricLabel]);

  return <div ref={el} style="width:100%;height:360px;" />;
}
