import { useEffect, useRef } from "preact/hooks";
import { echarts } from "../charts/echarts";
import { palette } from "../charts/theme";
import { useTimeseries } from "../hooks";
import { metric, theme } from "../state/store";

export function TrendChart() {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ReturnType<typeof echarts.init> | null>(null);
  const { data } = useTimeseries();
  const themeVal = theme.value; // subscribe
  const metricVal = metric.value;

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
    if (!chart.current || !data) return;
    const p = palette();
    chart.current.setOption(
      {
        grid: { left: 44, right: 16, top: 20, bottom: 28 },
        tooltip: { trigger: "axis" },
        xAxis: {
          type: "category",
          data: data.results.map((r) => r.date),
          axisLine: { lineStyle: { color: p.grid } },
          axisLabel: { color: p.muted },
        },
        yAxis: {
          type: "value",
          splitLine: { lineStyle: { color: p.grid } },
          axisLabel: { color: p.muted },
        },
        series: [
          {
            name: metricVal === "visitors" ? "Visitors" : "Page Views",
            type: "line",
            symbol: "circle",
            areaStyle: { opacity: 0.12 },
            lineStyle: { color: p.accent, width: 2 },
            itemStyle: { color: p.accent },
            data: data.results.map((r) => r.value),
          },
        ],
      },
      true
    );
  }, [data, themeVal, metricVal]);

  return (
    <div class="chart-card">
      <div ref={el} style="width:100%;height:260px;" />
    </div>
  );
}
