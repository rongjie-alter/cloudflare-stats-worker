import { lazy, Suspense } from "preact/compat";
import { useEffect } from "preact/hooks";
import { MenuBar } from "./components/MenuBar";
import { FilterBar } from "./components/FilterBar";
import { SummaryCards } from "./components/SummaryCards";
import { TrendChart } from "./components/TrendChart";
import { PanelGrid } from "./components/PanelGrid";
import { drawerDimension, theme, timezone, view } from "./state/store";
import { fetchConfig } from "./api/client";

// AG Grid + the drawer's heavy code load only when a panel is expanded.
const DetailDrawer = lazy(() => import("./components/DetailDrawer"));
// WebSocket + live charts only load once the "Live" tab is opened.
const LiveView = lazy(() => import("./components/live/LiveView"));

export function App() {
  useEffect(() => {
    document.documentElement.dataset.theme = theme.value;
    fetchConfig()
      .then((c) => {
        // Guarded because `timezone` feeds timeRange -> queryKey: assigning a
        // different value here re-fires every panel and the trend chart with new
        // dates, doubling a cold page load's queries. Same value = no-op.
        if (c?.timezone && c.timezone !== timezone.peek()) timezone.value = c.timezone;
      })
      .catch(() => {
        /* keep default tz */
      });
  }, []);

  return (
    <div class="app">
      <MenuBar />
      {view.value === "live" ? (
        <Suspense fallback={null}>
          <LiveView />
        </Suspense>
      ) : (
        <>
          <FilterBar />
          <SummaryCards />
          <TrendChart />
          <PanelGrid />
          {drawerDimension.value && (
            <Suspense fallback={null}>
              <DetailDrawer />
            </Suspense>
          )}
        </>
      )}
    </div>
  );
}
