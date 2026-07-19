import { resolve } from "node:path";
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
      input: {
        main: resolve(__dirname, "index.html"),
        beacon: resolve(__dirname, "../report.js"),
      },
      output: {
        entryFileNames: (info) =>
          info.name === "beacon" ? "report.js" : "assets/[name]-[hash].js",
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
