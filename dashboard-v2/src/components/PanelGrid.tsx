import { Panel } from "./Panel";
import { PANEL_DIMENSIONS } from "../state/store";

export function PanelGrid() {
  return (
    <div class="panel-grid">
      {PANEL_DIMENSIONS.map((d) => (
        <Panel dimension={d} />
      ))}
    </div>
  );
}
