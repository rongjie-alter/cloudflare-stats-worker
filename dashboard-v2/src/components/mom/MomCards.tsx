import type { Totals } from "../../duck/mom";
import { fmtChange, fmtNum, fmtSigned } from "../../utils/format";

function Delta({ a, b, digits = 0 }: { a: number; b: number; digits?: number }) {
  const cls = b > a ? "up" : b < a ? "down" : "";
  return (
    <span class={`mom-delta ${cls}`}>
      {fmtSigned(b - a, digits)} ({fmtChange(a, b)})
    </span>
  );
}

// Headline figures, B against A. Per-day averages are shown because months
// differ in length (and a partial month would otherwise always "lose").
export function MomCards({ a, b, labelA, labelB }: { a: Totals; b: Totals; labelA: string; labelB: string }) {
  const perDay = (t: Totals) => (t.days ? t.pv / t.days : 0);
  const card = (label: string, va: number, vb: number, digits = 0) => (
    <div class="card">
      <div class="label">{label}</div>
      <div class="value">{vb.toLocaleString(undefined, { maximumFractionDigits: digits })}</div>
      <div class="sub">
        <Delta a={va} b={vb} digits={digits} />
      </div>
      <div class="sub">
        {labelA}: {va.toLocaleString(undefined, { maximumFractionDigits: digits })}
      </div>
    </div>
  );
  return (
    <div class="cards">
      {card("Page views", a.pv, b.pv)}
      {card("Unique visitors", a.uv, b.uv)}
      {card("Page views / day", perDay(a), perDay(b), 1)}
      <div class="card">
        <div class="label">Days with data</div>
        <div class="value">{fmtNum(b.days)}</div>
        <div class="sub">{labelB}</div>
        <div class="sub">
          {labelA}: {fmtNum(a.days)}
        </div>
      </div>
    </div>
  );
}
