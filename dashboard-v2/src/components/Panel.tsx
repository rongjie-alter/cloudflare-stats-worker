import { useAggregate } from "../hooks";
import { addFilter, openDrawer, DIMENSION_LABELS } from "../state/store";
import type { AggregateRow, Dimension } from "../api/types";

function PanelRow({ dimension, row, max }: { dimension: Dimension; row: AggregateRow; max: number }) {
  const pct = max > 0 ? (row.value / max) * 100 : 0;
  return (
    <div class="row">
      <div class="bar" style={`width:${pct}%`} />
      <span class="key" title={row.key}>
        {row.key}
      </span>
      <span class="val">{row.value.toLocaleString()}</span>
      <span class="actions">
        <button title="Filter to this value" onClick={() => addFilter(dimension, "include", row.key)}>
          ✓
        </button>
        <button class="exclude" title="Exclude this value" onClick={() => addFilter(dimension, "exclude", row.key)}>
          ✕
        </button>
      </span>
    </div>
  );
}

export function Panel({ dimension }: { dimension: Dimension }) {
  const { data, loading, error } = useAggregate(dimension, 8);
  const rows = data?.results ?? [];
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0);

  return (
    <div class="panel">
      <div class="panel-head">
        <h3>{DIMENSION_LABELS[dimension]}</h3>
        <button class="expand" onClick={() => openDrawer(dimension)}>
          Details →
        </button>
      </div>
      {loading && <div class="loading">Loading…</div>}
      {error && <div class="empty">Error: {error}</div>}
      {!loading && !error && rows.length === 0 && <div class="empty">No data</div>}
      <div class="rows">
        {rows
          .filter((r) => r.key !== "(direct)" || dimension.startsWith("referrer"))
          .map((r) => (
            <PanelRow dimension={dimension} row={r} max={max} />
          ))}
      </div>
    </div>
  );
}
