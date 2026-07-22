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
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    const r = timeRange.value;
    api
      .query({ metric: metric.value, from: r.from, to: r.to, groupBy: dimension, filters: filters.value, limit })
      .then((data) => !cancelled && setState({ data, loading: false, error: null }))
      .catch((err) => !cancelled && setState({ data: null, loading: false, error: String(err.message || err) }));
    return () => {
      cancelled = true;
    };
  }, [key, dimension, limit]);

  return state;
}

// Top-N children fetched per ring, by 0-based depth. Keeps the sunburst
// readable and bounds the fan-out request count.
const HIERARCHY_LIMITS = [20, 12, 8];

// Fetch a dimension hierarchy by client-side fan-out: one grouped /api/query
// per node, filtered by its ancestors. Each node's value is therefore exact
// (including non-additive visitor counts). Reactive to metric/range/filters
// (via queryKey) and the active `levels`.
export function useHierarchy(levels: Dimension[]): AsyncState<HierarchyNode[]> {
  const [state, setState] = useState<AsyncState<HierarchyNode[]>>({ data: null, loading: true, error: null });
  const key = queryKey.value;
  const levelsKey = levels.join(">");

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    const r = timeRange.value;
    const base = { metric: metric.value, from: r.from, to: r.to };
    const baseFilters = filters.value;

    async function fetchLevel(dims: Dimension[], parentFilters: Filter[], depth: number): Promise<HierarchyNode[]> {
      const [dim, ...rest] = dims;
      const res = await api.query({
        ...base,
        groupBy: dim,
        filters: [...baseFilters, ...parentFilters],
        limit: HIERARCHY_LIMITS[depth] ?? 8,
      });
      const nodes: HierarchyNode[] = res.results.map((row) => ({ key: row.key, value: row.value, dim }));
      if (rest.length) {
        await Promise.all(
          nodes.map(async (n) => {
            n.children = await fetchLevel(
              rest,
              [...parentFilters, { dimension: dim, op: "include", value: n.key }],
              depth + 1
            );
          })
        );
      }
      return nodes;
    }

    fetchLevel(levels, [], 0)
      .then((tree) => !cancelled && setState({ data: tree, loading: false, error: null }))
      .catch((err) => !cancelled && setState({ data: null, loading: false, error: String(err.message || err) }));
    return () => {
      cancelled = true;
    };
  }, [key, levelsKey]);

  return state;
}

export function useTimeseries(): AsyncState<TimeseriesResponse> {
  const [state, setState] = useState<AsyncState<TimeseriesResponse>>({ data: null, loading: true, error: null });
  const key = queryKey.value;

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    const r = timeRange.value;
    api
      .timeseries({ metric: metric.value, from: r.from, to: r.to, filters: filters.value })
      .then((data) => !cancelled && setState({ data, loading: false, error: null }))
      .catch((err) => !cancelled && setState({ data: null, loading: false, error: String(err.message || err) }));
    return () => {
      cancelled = true;
    };
  }, [key]);

  return state;
}

export function useSummary(): AsyncState<SummaryResponse> {
  const [state, setState] = useState<AsyncState<SummaryResponse>>({ data: null, loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    api
      .summary()
      .then((data) => !cancelled && setState({ data, loading: false, error: null }))
      .catch((err) => !cancelled && setState({ data: null, loading: false, error: String(err.message || err) }));
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
