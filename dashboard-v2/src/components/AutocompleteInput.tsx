import { useState } from "preact/hooks";
import { matchSuggestions } from "../grid/autocomplete";

// A text input with a suggestion dropdown. Matching runs against the last
// comma-separated segment of the typed text, so multi-value entry (e.g.
// "JP,TW,...") still autocompletes the token currently being typed; picking
// a suggestion replaces just that trailing segment.
export function AutocompleteInput({
  value,
  onInput,
  suggestions,
  placeholder,
  class: className,
}: {
  value: string;
  onInput: (v: string) => void;
  suggestions: string[];
  placeholder?: string;
  class?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);

  const lastComma = value.lastIndexOf(",");
  const prefix = value.slice(0, lastComma + 1);
  const current = value.slice(lastComma + 1);
  const matches = matchSuggestions(current, suggestions);

  const select = (v: string) => {
    onInput(`${prefix}${v}`);
    setOpen(false);
    setHighlighted(-1);
  };

  return (
    <div class="ac-wrap">
      <input
        class={className}
        placeholder={placeholder}
        value={value}
        onInput={(e) => {
          onInput((e.target as HTMLInputElement).value);
          setOpen(true);
          setHighlighted(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!open || !matches.length) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlighted((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlighted((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter" && highlighted >= 0) {
            e.preventDefault();
            select(matches[highlighted]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && matches.length > 0 && (
        <div class="ac-list">
          {matches.map((m, i) => (
            <div
              class={`ac-item${i === highlighted ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                select(m);
              }}
            >
              {m}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
