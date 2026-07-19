import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Built output is served from the worker's Static Assets binding at "/".
export default defineConfig({
  base: "/",
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/echarts") || id.includes("node_modules/zrender")) return "echarts";
          if (id.includes("node_modules/ag-grid-community")) return "ag-grid";
        },
      },
    },
  },
  server: {
    // `vite dev` proxies API calls to a locally-running `wrangler dev`.
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/health": "http://127.0.0.1:8787",
    },
  },
});
