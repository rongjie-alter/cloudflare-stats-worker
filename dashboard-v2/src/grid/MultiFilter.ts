// AG Grid Community lookalike of the docs' "Multi Filter" (Text Filter + Set
// Filter, AND'ed) -- the real agSetColumnFilter is Enterprise-only, so this
// builds the same shape from Community APIs: a "contains" text filter with
// autocomplete suggestions, stacked above a checkbox list of every distinct
// value currently loaded for the column (both built from grid row data
// already in memory -- no extra query).
import type { IFilterComp, IFilterParams, IDoesFilterPassParams } from "ag-grid-community";
import { matchSuggestions } from "./autocomplete";

interface MultiFilterModel {
  filterType: "multi";
  text: string;
  excluded: string[];
}

export class MultiFilter implements IFilterComp {
  private params!: IFilterParams;
  private eGui!: HTMLDivElement;

  // Text section
  private textInput!: HTMLInputElement;
  private textList!: HTMLDivElement;
  private textValue = "";
  private textMatches: string[] = [];
  private textHighlighted = -1;

  // Set-lookalike section
  private searchInput!: HTMLInputElement;
  private selectAll!: HTMLInputElement;
  private valuesBox!: HTMLDivElement;
  private allValues: string[] = [];
  private excluded = new Set<string>();
  private search = "";

  init(params: IFilterParams) {
    this.params = params;
    this.allValues = this.pool();

    this.eGui = document.createElement("div");
    this.eGui.className = "mf-filter";

    const textWrap = document.createElement("div");
    textWrap.className = "ac-filter";

    this.textInput = document.createElement("input");
    this.textInput.type = "text";
    this.textInput.className = "ac-filter-input";
    this.textInput.placeholder = "Filter…";
    this.textInput.addEventListener("input", () => this.onTextInput());
    this.textInput.addEventListener("keydown", (e) => this.onTextKeyDown(e));
    this.textInput.addEventListener("blur", () => setTimeout(() => this.closeTextList(), 120));

    this.textList = document.createElement("div");
    this.textList.className = "ac-filter-list";
    this.textList.style.display = "none";

    textWrap.appendChild(this.textInput);
    textWrap.appendChild(this.textList);

    const divider = document.createElement("div");
    divider.className = "mf-divider";

    const setWrap = document.createElement("div");
    setWrap.className = "mf-set";

    this.searchInput = document.createElement("input");
    this.searchInput.type = "text";
    this.searchInput.className = "ac-filter-input";
    this.searchInput.placeholder = "Search values…";
    this.searchInput.addEventListener("input", () => {
      this.search = this.searchInput.value;
      this.renderValues();
    });

    const selectAllRow = document.createElement("label");
    selectAllRow.className = "mf-item mf-select-all";
    this.selectAll = document.createElement("input");
    this.selectAll.type = "checkbox";
    this.selectAll.checked = true;
    this.selectAll.addEventListener("change", () => {
      this.excluded = this.selectAll.checked ? new Set() : new Set(this.allValues);
      this.renderValues();
      this.params.filterChangedCallback();
    });
    const selectAllLabel = document.createElement("span");
    selectAllLabel.textContent = "(Select All)";
    selectAllRow.appendChild(this.selectAll);
    selectAllRow.appendChild(selectAllLabel);

    this.valuesBox = document.createElement("div");
    this.valuesBox.className = "mf-values";

    setWrap.appendChild(this.searchInput);
    setWrap.appendChild(selectAllRow);
    setWrap.appendChild(this.valuesBox);

    this.eGui.appendChild(textWrap);
    this.eGui.appendChild(divider);
    this.eGui.appendChild(setWrap);

    this.renderValues();
  }

  getGui(): HTMLElement {
    return this.eGui;
  }

  afterGuiAttached() {
    // The pool can go stale while this popup is closed (new rows loaded);
    // Community's client-side row model doesn't reliably fire
    // onNewRowsLoaded for setGridOption("rowData", ...), so refresh here too.
    this.allValues = this.pool();
    this.renderValues();
    this.textInput.focus();
  }

  onNewRowsLoaded() {
    this.allValues = this.pool();
    this.renderValues();
  }

  private pool(): string[] {
    const seen = new Set<string>();
    this.params.api.forEachNode((node) => {
      const v = this.params.getValue(node);
      if (v != null && v !== "") seen.add(String(v));
    });
    return [...seen].sort();
  }

  // --- Text filter section --------------------------------------------------

  private onTextInput() {
    this.textValue = this.textInput.value;
    this.params.filterChangedCallback();
    this.renderTextList();
  }

  private renderTextList() {
    this.textMatches = matchSuggestions(this.textValue, this.allValues);
    this.textHighlighted = -1;
    this.textList.innerHTML = "";
    if (!this.textMatches.length) {
      this.closeTextList();
      return;
    }
    for (const m of this.textMatches) {
      const item = document.createElement("div");
      item.className = "ac-item";
      item.textContent = m;
      item.onmousedown = (e) => {
        e.preventDefault(); // keep input focused so blur doesn't close the list first
        this.selectText(m);
      };
      this.textList.appendChild(item);
    }
    this.textList.style.display = "block";
  }

  private closeTextList() {
    this.textList.style.display = "none";
  }

  private selectText(v: string) {
    this.textValue = v;
    this.textInput.value = v;
    this.closeTextList();
    this.params.filterChangedCallback();
  }

  private onTextKeyDown(e: KeyboardEvent) {
    if (this.textList.style.display === "none" || !this.textMatches.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.textHighlighted = Math.min(this.textHighlighted + 1, this.textMatches.length - 1);
      this.updateTextHighlight();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.textHighlighted = Math.max(this.textHighlighted - 1, 0);
      this.updateTextHighlight();
    } else if (e.key === "Enter" && this.textHighlighted >= 0) {
      e.preventDefault();
      this.selectText(this.textMatches[this.textHighlighted]);
    } else if (e.key === "Escape") {
      this.closeTextList();
    }
  }

  private updateTextHighlight() {
    [...this.textList.children].forEach((el, i) => el.classList.toggle("active", i === this.textHighlighted));
  }

  // --- Set-lookalike section -------------------------------------------------

  private renderValues() {
    const q = this.search.trim().toLowerCase();
    const shown = q ? this.allValues.filter((v) => v.toLowerCase().includes(q)) : this.allValues;

    this.valuesBox.innerHTML = "";
    for (const v of shown) {
      const row = document.createElement("label");
      row.className = "mf-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !this.excluded.has(v);
      cb.addEventListener("change", () => {
        if (cb.checked) this.excluded.delete(v);
        else this.excluded.add(v);
        this.updateSelectAllState();
        this.params.filterChangedCallback();
      });
      const label = document.createElement("span");
      label.textContent = v;
      row.appendChild(cb);
      row.appendChild(label);
      this.valuesBox.appendChild(row);
    }
    this.updateSelectAllState();
  }

  private updateSelectAllState() {
    const excludedCount = this.allValues.filter((v) => this.excluded.has(v)).length;
    this.selectAll.checked = excludedCount === 0;
    this.selectAll.indeterminate = excludedCount > 0 && excludedCount < this.allValues.length;
  }

  // --- IFilterComp -----------------------------------------------------------

  doesFilterPass(params: IDoesFilterPassParams): boolean {
    const v = this.params.getValue(params.node);
    const str = v == null ? "" : String(v);
    if (this.textValue.trim() && !str.toLowerCase().includes(this.textValue.trim().toLowerCase())) return false;
    return !this.excluded.has(str);
  }

  isFilterActive(): boolean {
    return this.textValue.trim().length > 0 || this.excluded.size > 0;
  }

  getModel(): MultiFilterModel | null {
    return this.isFilterActive() ? { filterType: "multi", text: this.textValue, excluded: [...this.excluded] } : null;
  }

  setModel(model: MultiFilterModel | null) {
    this.textValue = model?.text ?? "";
    this.textInput.value = this.textValue;
    this.excluded = new Set(model?.excluded ?? []);
    this.renderValues();
  }
}
