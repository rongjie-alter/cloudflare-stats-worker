// Contract shared with the worker query API (src/index.js).

export type Metric = "visitors" | "pageviews";

export type Dimension =
  | "path"
  | "referrer_domain"
  | "referrer_path"
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

export type Preset = "today" | "yesterday" | "last7d" | "last28d";

export interface TimeRange {
  preset: Preset | "custom";
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

export interface AggregateRow {
  key: string;
  parent?: string;
  value: number;
}

export interface QueryResponse {
  metric: Metric;
  range: { from: string; to: string; timezone: string };
  group_by: Dimension;
  results: AggregateRow[];
  total: number;
  note?: string;
}

export interface TimeseriesResponse {
  metric: Metric;
  interval: "day";
  results: { date: string; value: number }[];
}

export interface SummaryResponse {
  timezone: string;
  today: { pv: number; uv: number };
  last7d: { pv: number; uv: number };
  last30d: { pv: number; uv: number };
  allTime: { pv: number; uv: number; uv_note?: string };
}

export interface QueryParams {
  metric: Metric;
  from: string;
  to: string;
  groupBy: Dimension;
  filters: Filter[];
  limit?: number;
}
