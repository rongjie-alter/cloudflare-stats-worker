import { useEffect, useState } from "preact/hooks";
import * as api from "./api/client";
import type {
  Dimension,
  Filter,
  HierarchyNode,
  QueryResponse,
  SummaryResponse,
  TimeseriesResponse,
} from "./api/types";
import { filters, metric, queryKey, timeRange } from "./state/store";

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useAggregate(dimension: Dimension, limit = 8): AsyncState<QueryResponse> {
  const [state, setState] = useState<AsyncState<QueryResponse>>({ data: null, loading: true, error: null });
  // queryKey.value read makes this reactive to metric/range/filter changes.
  const key = queryKey.value;

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    const r = timeRange.value;
    api
      .query(
        { metric: metric.value, from: r.from, to: r.to, groupBy: dimension, filters: filters.value, limit },
        controller.signal
      )
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setState({ data: null, loading: false, error: String(err.message || err) });
      });
    return () => controller.abort();
  }, [key, dimension, limit]);

  return state;
}

// Top-N children kept per ring, by 0-based depth. Keeps the sunburst readable.
const HIERARCHY_LIMITS = [20, 12, 8];

// Tuples pulled before truncation. Generous because it is one statement either
// way, and the worker caps `limit` well above this.
const HIERARCHY_TUPLE_LIMIT = 2000;

// Build a tree from a flat list of tuples, applying HIERARCHY_LIMITS per ring.
// The truncation is per-parent (each node keeps its own top-N children), which
// is what the old per-node fan-out produced -- a single global LIMIT would
// instead keep the top-N tuples overall and visibly change the chart.
interface TreeBucket {
  key: string;
  value: number;
  children: Map<string, TreeBucket>;
}

// `rows` may arrive in either response shape: a one-level hierarchy is a
// single-dimension query, which the API answers with the historical
// { key, value } rows rather than tuples.
function buildTree(
  levels: Dimension[],
  rows: { keys?: string[]; key?: string; value: number }[]
): HierarchyNode[] {
  const roots = new Map<string, TreeBucket>();

  for (const row of rows) {
    const keys = row.keys ?? [row.key ?? "(unknown)"];
    let level = roots;
    for (let depth = 0; depth < levels.length; depth += 1) {
      const key = keys[depth] ?? "(unknown)";
      let bucket = level.get(key);
      if (!bucket) {
        bucket = { key, value: 0, children: new Map() };
        level.set(key, bucket);
      }
      bucket.value += row.value;
      level = bucket.children;
    }
  }

  const collect = (level: Map<string, TreeBucket>, depth: number): HierarchyNode[] =>
    [...level.values()]
      .sort((a, b) => b.value - a.value)
      .slice(0, HIERARCHY_LIMITS[depth] ?? 8)
      .map((bucket) => {
        const node: HierarchyNode = { key: bucket.key, value: bucket.value, dim: levels[depth] };
        if (bucket.children.size) node.children = collect(bucket.children, depth + 1);
        return node;
      });

  return collect(roots, 0);
}

// Fetch a dimension hierarchy in ONE request. Previously this fanned out a
// grouped /api/query per node -- up to 261 requests and 522 full range scans for
// the 3-level device hierarchy, from a single click, which on its own could
// exceed a day's D1 read budget several times over. The worker now groups by all
// levels at once and returns whole tuples; the tree is assembled here.
//
// Note this makes each node's value a SUM over its descendants. That is exact
// for pageviews. For visitors the worker takes the raw path and returns exact
// per-tuple counts, but a parent ring still shows the sum of its children rather
// than distinct visitors for the parent -- a visitor using two browser versions
// counts twice in the browser ring. Proportions, which is what a sunburst is
// read for, are unaffected.
export function useHierarchy(levels: Dimension[]): AsyncState<HierarchyNode[]> {
  const [state, setState] = useState<AsyncState<HierarchyNode[]>>({ data: null, loading: true, error: null });
  const key = queryKey.value;
  const levelsKey = levels.join(">");

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    const r = timeRange.value;
    api
      .queryTuples(
        {
          metric: metric.value,
          from: r.from,
          to: r.to,
          groupBy: levels,
          filters: filters.value,
          limit: HIERARCHY_TUPLE_LIMIT,
        },
        controller.signal
      )
      .then((res) => setState({ data: buildTree(levels, res.results), loading: false, error: null }))
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setState({ data: null, loading: false, error: String(err.message || err) });
      });
    return () => controller.abort();
  }, [key, levelsKey]);

  return state;
}

export function useTimeseries(): AsyncState<TimeseriesResponse> {
  const [state, setState] = useState<AsyncState<TimeseriesResponse>>({ data: null, loading: true, error: null });
  const key = queryKey.value;

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    const r = timeRange.value;
    api
      .timeseries({ metric: metric.value, from: r.from, to: r.to, filters: filters.value }, controller.signal)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setState({ data: null, loading: false, error: String(err.message || err) });
      });
    return () => controller.abort();
  }, [key]);

  return state;
}

export function useSummary(): AsyncState<SummaryResponse> {
  const [state, setState] = useState<AsyncState<SummaryResponse>>({ data: null, loading: true, error: null });
  useEffect(() => {
    const controller = new AbortController();
    api
      .summary(controller.signal)
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setState({ data: null, loading: false, error: String(err.message || err) });
      });
    return () => controller.abort();
  }, []);
  return state;
}
