// Tree-shaken ECharts registry — only the pieces the dashboard uses.
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart, MapChart, SunburstChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  DatasetComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  MapChart,
  SunburstChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  DatasetComponent,
  CanvasRenderer,
]);

export { echarts };

let worldRegistered = false;

// Lazy-load + register the self-hosted world map keyed by ISO alpha-2.
export async function ensureWorldMap(): Promise<void> {
  if (worldRegistered) return;
  const res = await fetch("/geo/world.json");
  const geo = await res.json();
  echarts.registerMap("world", geo);
  worldRegistered = true;
}
