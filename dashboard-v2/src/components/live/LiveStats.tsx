function fmt(n: number): string {
  return n.toLocaleString();
}

export function LiveStats({ pageViews, visitorCount }: { pageViews: number; visitorCount: number }) {
  return (
    <div class="cards live-cards">
      <div class="card">
        <div class="label">Page views</div>
        <div class="value">{fmt(pageViews)}</div>
        <div class="sub">since this dashboard opened</div>
      </div>
      <div class="card">
        <div class="label">Unique visitors</div>
        <div class="value">{fmt(visitorCount)}</div>
        <div class="sub">since this dashboard opened</div>
      </div>
    </div>
  );
}
