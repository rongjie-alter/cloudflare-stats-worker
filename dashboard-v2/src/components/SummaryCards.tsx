import { useSummary } from "../hooks";

function fmt(n: number): string {
  return n.toLocaleString();
}

export function SummaryCards() {
  const { data, loading, error } = useSummary();

  const card = (label: string, pv: number, uv: number) => (
    <div class="card">
      <div class="label">{label}</div>
      <div class="value">{fmt(pv)}</div>
      <div class="sub">{fmt(uv)} visitors</div>
    </div>
  );

  if (loading) return <div class="cards"><div class="card"><div class="loading">Loading…</div></div></div>;
  if (error || !data) return <div class="cards"><div class="card"><div class="empty">Failed to load summary</div></div></div>;

  return (
    <div class="cards">
      {card("Today", data.today.pv, data.today.uv)}
      {card("Last 7 days", data.last7d.pv, data.last7d.uv)}
      {card("Last 30 days", data.last30d.pv, data.last30d.uv)}
      {card("All time", data.allTime.pv, data.allTime.uv)}
    </div>
  );
}
