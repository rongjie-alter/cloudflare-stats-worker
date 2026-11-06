import type { DailyUv } from "../api/types";
import { useSummary } from "../hooks";

function fmt(n: number): string {
  return n.toLocaleString();
}

export function SummaryCards() {
  const { data, loading, error } = useSummary();

  // Pageviews are always live and exact. Visitors are a daily figure (ids are
  // salted per day and cannot be linked across days), so Today shows the live
  // count and the wider windows show the average per closed day with its range.
  const sub = (uv: number | DailyUv | null) => {
    if (uv === null) return "visitors pending";
    if (typeof uv === "number") return `${fmt(uv)} visitors`;
    return (
      <span title={`Over ${uv.days} closed day${uv.days === 1 ? "" : "s"} with traffic`}>
        avg {fmt(uv.avg)} visitors/day
        <span class="as-of">
          {" "}
          · {fmt(uv.min)}–{fmt(uv.max)}
        </span>
      </span>
    );
  };

  const card = (label: string, pv: number, uv: number | DailyUv | null) => (
    <div class="card">
      <div class="label">{label}</div>
      <div class="value">{fmt(pv)}</div>
      <div class="sub">{sub(uv)}</div>
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
