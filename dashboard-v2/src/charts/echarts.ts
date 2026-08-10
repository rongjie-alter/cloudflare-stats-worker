// Tree-shaken ECharts registry — only the pieces the dashboard uses.
import * as echarts from "echarts/core";
import {
  BarChart,
  LineChart,
  PieChart,
  MapChart,
  SunburstChart,
  ScatterChart,
  EffectScatterChart,
} from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  DatasetComponent,
  GeoComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  MapChart,
  SunburstChart,
  ScatterChart,
  EffectScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  DatasetComponent,
  GeoComponent,
  CanvasRenderer,
]);

export { echarts };

let worldRegistered = false;
const centroidByIso = new Map<string, [number, number]>();

type Ring = [number, number][];

// Signed shoelace area (x2) of a ring.
function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

// Area-weighted centroid of a ring (not a plain vertex average, which would
// skew toward whichever edge has the most sampled points).
function ringCentroid(ring: Ring): [number, number] {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  a /= 2;
  if (a === 0) {
    const n = ring.length;
    const sum = ring.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
    return [sum[0] / n, sum[1] / n];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

// For multi-part countries (archipelagos, islands + mainland), centroid the
// largest ring by area so the dot lands on the main landmass rather than
// averaging out over open ocean between parts.
function largestRingCentroid(geometry: { type: string; coordinates: any }): [number, number] | null {
  const polygons: Ring[][] = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let best: Ring | null = null;
  let bestArea = -Infinity;
  for (const poly of polygons) {
    const outer = poly[0];
    if (!outer || outer.length < 4) continue;
    const area = Math.abs(ringArea(outer));
    if (area > bestArea) {
      bestArea = area;
      best = outer;
    }
  }
  return best ? ringCentroid(best) : null;
}

// Lazy-load + register the self-hosted world map keyed by ISO alpha-2, and
// derive a centroid per country from the same payload for point placement.
export async function ensureWorldMap(): Promise<void> {
  if (worldRegistered) return;
  const res = await fetch("/geo/world.json");
  const geo = await res.json();
  echarts.registerMap("world", geo);
  for (const feature of geo.features) {
    const code = feature.properties?.ISO_A2_EH;
    if (!code) continue;
    const centroid = largestRingCentroid(feature.geometry);
    if (centroid) centroidByIso.set(code, centroid);
  }
  worldRegistered = true;
}

export function getCountryCentroid(code: string): [number, number] | undefined {
  return centroidByIso.get(code);
}
