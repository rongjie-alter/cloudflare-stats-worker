import { useEffect, useRef, useState } from "preact/hooks";
import { echarts, ensureWorldMap, getCountryCentroid } from "../../charts/echarts";
import { palette } from "../../charts/theme";
import { theme } from "../../state/store";
import { countryName } from "../../utils/countryName";

// How long a dot keeps rippling after a new event lands for that country.
const PULSE_DURATION_MS = 1500;
const PULSE_TICK_MS = 200;
const MIN_DOT_SIZE = 6;
const MAX_DOT_SIZE = 40;

// Sqrt scale so dot *area* (not radius) roughly tracks visitor count.
function dotSize(value: number): number {
  return Math.max(MIN_DOT_SIZE, Math.min(MAX_DOT_SIZE, MIN_DOT_SIZE + Math.sqrt(value) * 6));
}

export function LiveMap({ countryCounts }: { countryCounts: Record<string, number> }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ReturnType<typeof echarts.init> | null>(null);
  const [ready, setReady] = useState(false);
  const themeVal = theme.value;

  const prevCounts = useRef<Record<string, number>>({});
  const pulses = useRef<Map<string, number>>(new Map());
  const tickInterval = useRef<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let disposed = false;
    ensureWorldMap().then(() => {
      if (disposed || !el.current) return;
      chart.current = echarts.init(el.current);
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
      if (tickInterval.current !== null) {
        clearInterval(tickInterval.current);
        tickInterval.current = null;
      }
    };
  }, []);

  // countryCounts is a fresh object on every pageview message, so diffing it
  // against the previous render tells us which country just got an event --
  // no need for LiveView to track per-event timestamps separately.
  useEffect(() => {
    const prev = prevCounts.current;
    let added = false;
    for (const [code, value] of Object.entries(countryCounts)) {
      if (value > (prev[code] || 0) && getCountryCentroid(code)) {
        pulses.current.set(code, Date.now());
        added = true;
      }
    }
    prevCounts.current = countryCounts;
    if (!added) return;

    setTick((n) => n + 1);
    if (tickInterval.current === null) {
      tickInterval.current = window.setInterval(() => {
        const now = Date.now();
        for (const [code, startedAt] of pulses.current) {
          if (now - startedAt > PULSE_DURATION_MS) pulses.current.delete(code);
        }
        if (pulses.current.size === 0 && tickInterval.current !== null) {
          clearInterval(tickInterval.current);
          tickInterval.current = null;
        }
        setTick((n) => n + 1);
      }, PULSE_TICK_MS);
    }
  }, [countryCounts]);

  useEffect(() => {
    if (!ready || !chart.current) return;
    const p = palette();
    const noDataColor = p.dark ? "#d1d5db" : "#f1f3f4";

    const dots = Object.entries(countryCounts)
      .filter(([, value]) => value > 0)
      .map(([code, value]) => {
        const centroid = getCountryCentroid(code);
        return centroid ? { name: code, value: [centroid[0], centroid[1], value] } : null;
      })
      .filter((d): d is { name: string; value: [number, number, number] } => d !== null);

    const pulseDots = dots.filter((d) => pulses.current.has(d.name));

    chart.current.setOption(
      {
        tooltip: {
          trigger: "item",
          formatter: (o: any) => `${countryName(o.name)}: ${o.value?.[2] ?? 0}`,
        },
        geo: {
          map: "world",
          roam: true,
          itemStyle: { areaColor: noDataColor, borderColor: p.grid },
          emphasis: { itemStyle: { areaColor: noDataColor } },
        },
        series: [
          {
            name: "Live visitors",
            type: "scatter",
            coordinateSystem: "geo",
            symbolSize: (val: [number, number, number]) => dotSize(val[2]),
            itemStyle: {
              color: "rgba(79,140,255,0.80)",
              borderColor: "rgba(79,140,255,1)",
              borderWidth: 1,
            },
            data: dots,
          },
          {
            name: "New activity",
            type: "effectScatter",
            coordinateSystem: "geo",
            rippleEffect: { period: 1, scale: 3, brushType: "stroke" },
            symbolSize: (val: [number, number, number]) => dotSize(val[2]),
            itemStyle: { color: "rgba(79,140,255,0.85)" },
            data: pulseDots,
          },
        ],
      },
      true
    );
  }, [ready, countryCounts, themeVal, tick]);

  return (
    <div class="chart-card">
      <div class="panel-head"><h3>Live map</h3></div>
      <div ref={el} style="width:100%;height:320px;" />
    </div>
  );
}
