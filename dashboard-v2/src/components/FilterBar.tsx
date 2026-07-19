import { filters, removeFilter, clearFilters, DIMENSION_LABELS } from "../state/store";

export function FilterBar() {
  const active = filters.value;
  if (!active.length) return <div class="chips" />;
  return (
    <div class="chips">
      {active.map((f) => (
        <span class={`chip ${f.op}`} title={`${f.op} ${f.dimension} = ${f.value}`}>
          {f.op === "exclude" ? "≠ " : ""}
          {DIMENSION_LABELS[f.dimension]}: {f.value}
          <button aria-label="Remove filter" onClick={() => removeFilter(f)}>
            ×
          </button>
        </span>
      ))}
      <button class="btn" onClick={clearFilters}>
        Clear all
      </button>
    </div>
  );
}
