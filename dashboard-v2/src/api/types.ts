// Contract shared with the worker query API (src/routes/).

export type Metric = "visitors" | "pageviews";

export type Dimension =
  | "path"
  | "referrer_domain"
  | "country"
  | "browser"
  | "browser_version"
  | "os"
  | "os_version"
  | "device_type"
  | "device_vendor"
  | "device_model";

export type FilterOp = "include" | "exclude";

export interface Filter {
  dimension: Dimension;
  op: FilterOp;
  value: string;
}

export interface AggregateRow {
  key: string;
  value: number;
  prev?: number; // the comparison period's value (Reports only)
}

// One row of a multi-dimension breakdown: the whole tuple, outermost first.
export interface TupleRow {
  keys: string[];
  value: number;
  prev?: number;
}

// A node in a dimension hierarchy (sunburst), assembled client-side from the
// tuples returned by a single multi-dimension query.
export interface HierarchyNode {
  key: string;
  value: number;
  prev?: number; // the comparison period's value (Reports only)
  dim: Dimension;
  children?: HierarchyNode[];
}

export interface QueryResponse {
  metric: Metric;
  range: { from: string; to: string; timezone: string };
  group_by: Dimension;
  results: AggregateRow[];
  total: number;
  note?: string;
  // metric=visitors only: site-wide daily visitors over the range.
  daily?: { avg: number; min: number; max: number };
}

// Response shape when group_by names more than one dimension.
export interface TupleQueryResponse {
  metric: Metric;
  range: { from: string; to: string; timezone: string };
  group_by: Dimension[];
  results: TupleRow[];
  total: number;
  note?: string;
}

export interface TimeseriesResponse {
  metric: Metric;
  interval: "day";
  results: { date: string; value: number }[];
}

// Visitors are a DAILY metric: ids are salted per day, so they cannot be linked
// across days. Pageviews are live and exact. `today.uv` is live; every window's
// `uv` is the avg / min / max of the per-day figure over the closed days in it
// (null while there are none yet).
export interface DailyUv {
  avg: number;
  min: number;
  max: number;
  days: number;
}

export interface SummaryResponse {
  timezone: string;
  today: { pv: number; uv: number };
  last7d: { pv: number; uv: DailyUv | null };
  last30d: { pv: number; uv: DailyUv | null };
  allTime: { pv: number; uv: DailyUv | null; uv_note?: string };
}

export interface QueryParams {
  metric: Metric;
  from: string;
  to: string;
  groupBy: Dimension | Dimension[];
  filters?: Filter[];
  limit?: number;
}
