const MAX_ROWS = 10;

export function LivePathBreakdown({ pathCounts }: { pathCounts: Record<string, number> }) {
  const rows = Object.entries(pathCounts)
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_ROWS);
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0);

  return (
    <div class="panel">
      <div class="panel-head">
        <h3>Page views by path</h3>
      </div>
      {rows.length === 0 && <div class="empty">No pageviews yet</div>}
      <div class="rows">
        {rows.map((r) => (
          <div class="row">
            <div class="bar" style={`width:${max > 0 ? (r.value / max) * 100 : 0}%`} />
            <span class="key" title={r.key}>
              {r.key}
            </span>
            <span class="val">{r.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
