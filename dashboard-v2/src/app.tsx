import { lazy, Suspense } from "preact/compat";
import { useEffect } from "preact/hooks";
import { MenuBar } from "./components/MenuBar";
import { FilterBar } from "./components/FilterBar";
import { SummaryCards } from "./components/SummaryCards";
import { TrendChart } from "./components/TrendChart";
import { PanelGrid } from "./components/PanelGrid";
import { drawerDimension, theme, timezone } from "./state/store";
import { fetchConfig } from "./api/client";

// AG Grid + the drawer's heavy code load only when a panel is expanded.
const DetailDrawer = lazy(() => import("./components/DetailDrawer"));

export function App() {
  useEffect(() => {
    document.documentElement.dataset.theme = theme.value;
    fetchConfig()
      .then((c) => {
        if (c?.timezone) timezone.value = c.timezone;
      })
      .catch(() => {
        /* keep default tz */
      });
  }, []);

  return (
    <div class="app">
      <MenuBar />
      <FilterBar />
      <SummaryCards />
      <TrendChart />
      <PanelGrid />
      {drawerDimension.value && (
        <Suspense fallback={null}>
          <DetailDrawer />
        </Suspense>
      )}
    </div>
  );
}
