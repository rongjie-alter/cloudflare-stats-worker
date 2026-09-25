import { useEffect, useRef, useState } from "preact/hooks";
import { echarts } from "../../charts/echarts";
import { palette, SERIES_COLORS } from "../../charts/theme";
import type { TrendPoint } from "../../duck/mom";
import { theme } from "../../state/store";

// Both months on one day-of-month axis (1..31), so the same point in each
// month lines up regardless of weekday or month length.
export function MomTrend({
  a,
  b,
  labelA,
  labelB,
  days,
  metric,
}: {
  a: TrendPoint[];
  b: TrendPoint[];
  labelA: string;
  labelB: string;
  days: number;
  metric: "pv" | "uv";
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ReturnType<typeof echarts.init> | null>(null);
  const [ready, setReady] = useState(false);
  const themeVal = theme.value;

  useEffect(() => {
    if (!el.current) return;
    chart.current = echarts.init(el.current);
    const onResize = () => chart.current?.resize();
    window.addEventListener("resize", onResize);
    setReady(true);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready || !chart.current) return;
    const p = palette();
    const axis = Array.from({ length: days }, (_, i) => i + 1);
    const series = (points: TrendPoint[]) => {
      const byDay = new Map(points.map((pt) => [pt.dom, pt[metric]]));
      // Missing days are gaps (null), not zeros: no data is not "no traffic".
      return axis.map((d) => byDay.get(d) ?? null);
    };
    chart.current.setOption(
      {
        grid: { left: 48, right: 16, top: 32, bottom: 28 },
        legend: { data: [labelA, labelB], textStyle: { color: p.muted }, top: 0 },
        tooltip: { trigger: "axis" },
        xAxis: {
          type: "category",
          data: axis,
          name: "day",
          nameTextStyle: { color: p.muted },
          axisLine: { lineStyle: { color: p.grid } },
          axisLabel: { color: p.muted },
        },
        yAxis: {
          type: "value",
          minInterval: 1,
          splitLine: { lineStyle: { color: p.grid } },
          axisLabel: { color: p.muted },
        },
        series: [
          {
            name: labelA,
            type: "line",
            symbol: "circle",
            lineStyle: { width: 2, type: "dashed", color: SERIES_COLORS[2] },
            itemStyle: { color: SERIES_COLORS[2] },
            data: series(a),
          },
          {
            name: labelB,
            type: "line",
            symbol: "circle",
            areaStyle: { opacity: 0.12 },
            lineStyle: { width: 2, color: p.accent },
            itemStyle: { color: p.accent },
            data: series(b),
          },
        ],
      },
      true
    );
  }, [ready, a, b, labelA, labelB, days, metric, themeVal]);

  return <div ref={el} style="width:100%;height:260px;" />;
}
