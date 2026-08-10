import { useEffect, useRef, useState } from "preact/hooks";
import { LiveMap } from "./LiveMap";
import { LivePathBreakdown } from "./LivePathBreakdown";
import { LiveStats } from "./LiveStats";
import { LiveTimeline } from "./LiveTimeline";

// Minutes of history the timeline keeps. Older buckets are dropped as new
// events arrive, and everything here lives only in this component's state --
// closing the tab (or switching away and back, which unmounts this component)
// throws it all away and the next connection starts counting from zero.
const TIMELINE_MINUTES = 30;

export interface MinuteBucket {
  minute: number; // epoch minutes (ts / 60000, floored)
  pv: number;
  visitors: Set<string>;
}

interface LiveState {
  pageViews: number;
  pathCounts: Record<string, number>;
  countryCounts: Record<string, number>;
  visitorIds: Set<string>;
  minuteBuckets: Map<number, MinuteBucket>;
}

type Status = "connecting" | "open" | "rejected" | "closed";

function emptyState(): LiveState {
  return {
    pageViews: 0,
    pathCounts: {},
    countryCounts: {},
    visitorIds: new Set(),
    minuteBuckets: new Map(),
  };
}

function wsUrl(): string {
  return `${location.origin.replace(/^http/, "ws")}/api/realtime`;
}

export default function LiveView() {
  const [status, setStatus] = useState<Status>("connecting");
  const [state, setState] = useState<LiveState>(emptyState);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setState(emptyState());
    const socket = new WebSocket(wsUrl());
    socketRef.current = socket;
    setStatus("connecting");

    socket.addEventListener("open", () => setStatus("open"));
    socket.addEventListener("close", (e) => {
      // 1006/1000 with no prior "open" almost always means the Worker refused
      // the upgrade (single-viewer slot already taken) -- there is no HTTP
      // status visible on a browser WebSocket, only the close event.
      setStatus((prev) => (prev === "open" ? "closed" : "rejected"));
    });
    socket.addEventListener("error", () => {
      /* the close handler above reports the outcome */
    });

    socket.addEventListener("message", (e) => {
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg?.type !== "pageview") return;

      setState((prev) => {
        const visitorId = String(msg.visitorId);
        const path = msg.path || "/";
        const country = msg.country || "XX";
        const minute = Math.floor(Number(msg.ts) / 60000);

        const pathCounts = { ...prev.pathCounts, [path]: (prev.pathCounts[path] || 0) + 1 };
        const countryCounts = { ...prev.countryCounts, [country]: (prev.countryCounts[country] || 0) + 1 };
        const visitorIds = new Set(prev.visitorIds);
        visitorIds.add(visitorId);

        const minuteBuckets = new Map(prev.minuteBuckets);
        const existing = minuteBuckets.get(minute);
        const visitors = new Set(existing?.visitors ?? []);
        visitors.add(visitorId);
        minuteBuckets.set(minute, { minute, pv: (existing?.pv ?? 0) + 1, visitors });
        const cutoff = minute - (TIMELINE_MINUTES - 1);
        for (const key of minuteBuckets.keys()) {
          if (key < cutoff) minuteBuckets.delete(key);
        }

        return {
          pageViews: prev.pageViews + 1,
          pathCounts,
          countryCounts,
          visitorIds,
          minuteBuckets,
        };
      });
    });

    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, []);

  if (status === "rejected") {
    return (
      <div class="live-message">Another browser is already viewing the live dashboard.</div>
    );
  }

  return (
    <div class="live-view">
      <div class="live-status">
        <span class={`live-dot ${status}`} />
        {status === "connecting" && "Connecting…"}
        {status === "open" && "Live"}
        {status === "closed" && "Disconnected"}
      </div>
      <LiveStats pageViews={state.pageViews} visitorCount={state.visitorIds.size} />
      <LiveTimeline buckets={state.minuteBuckets} minutes={TIMELINE_MINUTES} />
      <div class="live-grid">
        <LiveMap countryCounts={state.countryCounts} />
        <LivePathBreakdown pathCounts={state.pathCounts} />
      </div>
    </div>
  );
}
