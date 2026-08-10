#!/usr/bin/env node
// Build dashboard-v2/public/geo/world.json from a Natural Earth admin-0
// countries GeoJSON cut.
//
// The previous file was Natural Earth's 1:110m ("lowres") cut, which drops
// small countries (Singapore, Bahrain, Brunei, ...) outright at that
// generalization scale. This trims a higher-resolution cut (1:50m recommended)
// down to just the properties CountryMap.tsx actually reads -- it matches
// polygons via `nameProperty: "ISO_A2_EH"` (src/components/CountryMap.tsx) and
// looks up the display name separately via Intl.DisplayNames, so nothing else
// in the ~150-column Natural Earth schema is needed -- and rounds coordinate
// precision to keep the file size reasonable despite the added detail.
//
//   node scripts/build-world-map.mjs <path-to-ne_admin_0_countries.geojson>
//
// Source (1:50m): https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_50m_admin_0_countries.geojson

import { readFileSync, writeFileSync } from "node:fs";

const SRC = process.argv[2];
if (!SRC) {
  console.error("usage: node scripts/build-world-map.mjs <ne_admin_0_countries.geojson>");
  process.exit(1);
}

const PRECISION = 4; // ~11m at the equator -- plenty for a world-view choropleth

function round(coords) {
  if (typeof coords[0] === "number") {
    return coords.map((n) => Math.round(n * 10 ** PRECISION) / 10 ** PRECISION);
  }
  return coords.map(round);
}

const raw = JSON.parse(readFileSync(SRC, "utf8"));

const out = {
  type: "FeatureCollection",
  features: raw.features.map((f) => ({
    type: "Feature",
    properties: {
      NAME: f.properties.NAME,
      ISO_A2: f.properties.ISO_A2,
      ISO_A2_EH: f.properties.ISO_A2_EH,
    },
    geometry: {
      type: f.geometry.type,
      coordinates: round(f.geometry.coordinates),
    },
  })),
};

const dest = new URL("../dashboard-v2/public/geo/world.json", import.meta.url);
writeFileSync(dest, JSON.stringify(out));
console.log(`wrote ${out.features.length} features to ${dest.pathname.slice(1)}`);
