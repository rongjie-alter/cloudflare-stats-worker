import { useSummary } from "../hooks";

function fmt(n: number): string {
  return n.toLocaleString();
}

export function SummaryCards() {
  const { data, loading, error } = useSummary();

  // Pageviews are always live and exact. Visitor counts are exact for today but
  // come from the worker's nightly snapshot for the wider windows, because
  // COUNT(DISTINCT) cannot be summed across days -- computing them live meant a
  // full-table scan on every page load. `asOf` labels that.
  const card = (label: string, pv: number, uv: number | null, asOf?: string | null) => (
    <div class="card">
      <div class="label">{label}</div>
      <div class="value">{fmt(pv)}</div>
      <div class="sub" title={asOf ? `Visitor count as of ${asOf}` : undefined}>
        {uv === null ? "visitors pending" : `${fmt(uv)} visitors`}
        {asOf && uv !== null ? <span class="as-of"> · as of {asOf}</span> : null}
      </div>
    </div>
  );

  if (loading) return <div class="cards"><div class="card"><div class="loading">Loading…</div></div></div>;
  if (error || !data) return <div class="cards"><div class="card"><div class="empty">Failed to load summary</div></div></div>;

  const asOf = data.uv_as_of;
  return (
    <div class="cards">
      {card("Today", data.today.pv, data.today.uv)}
      {card("Last 7 days", data.last7d.pv, data.last7d.uv, asOf)}
      {card("Last 30 days", data.last30d.pv, data.last30d.uv, asOf)}
      {card("All time", data.allTime.pv, data.allTime.uv, asOf)}
    </div>
  );
}
