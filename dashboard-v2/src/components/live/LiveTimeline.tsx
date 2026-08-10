import { useEffect, useRef, useState } from "preact/hooks";
import { echarts } from "../../charts/echarts";
import { palette } from "../../charts/theme";
import { theme } from "../../state/store";
import type { MinuteBucket } from "./LiveView";

// Ticks the x-axis forward even when no events arrive, so the chart reads as
// "live" rather than frozen at the last pageview.
const TICK_MS = 15000;

function fmtMinute(epochMinute: number): string {
  return new Date(epochMinute * 60000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function LiveTimeline({ buckets, minutes }: { buckets: Map<number, MinuteBucket>; minutes: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ReturnType<typeof echarts.init> | null>(null);
  const [ready, setReady] = useState(false);
  const [nowMinute, setNowMinute] = useState(() => Math.floor(Date.now() / 60000));
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
    const id = setInterval(() => setNowMinute(Math.floor(Date.now() / 60000)), TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!ready || !chart.current) return;
    const p = palette();
    const start = nowMinute - (minutes - 1);
    const labels: string[] = [];
    const pv: number[] = [];
    const uv: number[] = [];
    for (let m = start; m <= nowMinute; m += 1) {
      const bucket = buckets.get(m);
      labels.push(fmtMinute(m));
      pv.push(bucket?.pv ?? 0);
      uv.push(bucket?.visitors.size ?? 0);
    }

    chart.current.setOption(
      {
        grid: { left: 44, right: 16, top: 28, bottom: 28 },
        legend: { data: ["Page views", "Visitors"], textStyle: { color: p.muted }, top: 0 },
        tooltip: { trigger: "axis" },
        xAxis: {
          type: "category",
          data: labels,
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
            name: "Page views",
            type: "line",
            symbol: "circle",
            areaStyle: { opacity: 0.12 },
            lineStyle: { color: p.accent, width: 2 },
            itemStyle: { color: p.accent },
            data: pv,
          },
          {
            name: "Visitors",
            type: "line",
            symbol: "circle",
            lineStyle: { width: 2 },
            data: uv,
          },
        ],
      },
      true
    );
  }, [ready, buckets, nowMinute, minutes, themeVal]);

  return (
    <div class="chart-card">
      <div ref={el} style="width:100%;height:220px;" />
    </div>
  );
}
