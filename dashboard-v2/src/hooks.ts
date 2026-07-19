import { useEffect, useState } from "preact/hooks";
import * as api from "./api/client";
import type { Dimension, QueryResponse, SummaryResponse, TimeseriesResponse } from "./api/types";
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
