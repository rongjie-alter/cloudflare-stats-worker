// Parquet archive of raw pageviews -- one immutable file per closed day in R2.
//
// Every file is self-contained and denormalized: dimension *strings* are stored
// (Parquet dictionary-encodes them, so a repeated path costs a few bits per
// row, not its bytes), never the per-deployment dim ids. A daily file, the live
// file, a month the dashboard exports and a file it imports back all share this
// one schema, so DuckDB can union any of them.
//
//   day         INT32   yyyymmdd in the configured timezone
//   visitor_id  INT64   52-bit hash, as in events_tab
//   <dimension> STRING  one nullable column per DIMENSIONS key; NULL = direct/unknown
//
// Shared by the worker (nightly export, live endpoint) and the Node scripts
// (backfill, verify, bench), so every producer writes byte-identical layouts.
//
// CPU is the binding constraint: Workers Free allows 10ms per invocation,
// cron included. Keep this path a single pass over typed arrays + Map lookups.

import { ByteWriter } from "hyparquet-writer/src/bytewriter.js";
import { writePageHeader } from "hyparquet-writer/src/datapage.js";
import { writeRleBitPackedHybrid } from "hyparquet-writer/src/encoding.js";
import { writeMetadata } from "hyparquet-writer/src/metadata.js";
import { writePlain } from "hyparquet-writer/src/plain.js";
import { DIMENSIONS } from "./dimensions.js";

const PARQUET_MAGIC = 0x31524150; // "PAR1"

export const ARCHIVE_SCHEMA_VERSION = "1";
export const ARCHIVE_PREFIX = `events/v${ARCHIVE_SCHEMA_VERSION}/`;
export const ARCHIVE_CONTENT_TYPE = "application/vnd.apache.parquet";

export const DIMENSION_NAMES = Object.keys(DIMENSIONS);
const DIM_ENTRIES = Object.values(DIMENSIONS);

// events_tab column order the encoder expects from fetchDayRows().
export const FACT_COLUMNS = ["day", "visitor_id", ...DIM_ENTRIES.map((d) => d.col)];

// yyyymmdd -> "events/v1/YYYY/MM/YYYYMMDD.parquet"
export function archiveKey(day) {
  const s = String(day);
  return `${ARCHIVE_PREFIX}${s.slice(0, 4)}/${s.slice(4, 6)}/${s}.parquet`;
}

// Inverse of archiveKey; null for anything that is not a day file.
export function dayFromKey(key) {
  const m = /\/(\d{8})\.parquet$/.exec(key);
  return m ? Number(m[1]) : null;
}

// One statement, `.raw()` so D1 hands back arrays instead of building an
// object per row. Uses idx_events_day; reads one row per pageview.
export async function fetchDayRows(db, from, to) {
  return db
    .prepare(`SELECT ${FACT_COLUMNS.join(", ")} FROM events_tab WHERE day BETWEEN ? AND ?`)
    .bind(from, to)
    .raw();
}

// id -> value for only the dim rows these events reference. The ids travel as
// one JSON parameter (json_each), which sidesteps D1's 100-bound-parameter cap
// and keeps rows read to the number of *distinct* values, not events.
export async function fetchDimMaps(db, rows) {
  const idSets = DIM_ENTRIES.map(() => new Set());
  for (const row of rows) {
    for (let j = 0; j < DIM_ENTRIES.length; j += 1) {
      const id = row[2 + j];
      if (id !== null) idSets[j].add(id);
    }
  }
  const maps = DIM_ENTRIES.map(() => new Map());
  const wanted = DIM_ENTRIES.map((dim, j) => ({ dim, j })).filter(({ j }) => idSets[j].size > 0);
  if (wanted.length === 0) return maps;
  const results = await db.batch(
    wanted.map(({ dim, j }) =>
      db
        .prepare(`SELECT id, value FROM ${dim.table} WHERE id IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify([...idSets[j]]))
    )
  );
  wanted.forEach(({ j }, k) => {
    for (const r of results[k].results) maps[j].set(r.id, r.value);
  });
  return maps;
}

// --- Encoder -----------------------------------------------------------------
//
// Why not just parquetWriteBuffer(): measured at 25-65ms for a 7.5K-row day
// (bench-archive.mjs), several times the 10ms budget. Nearly all of it is
// generic per-row work on strings -- sampling and hashing values to discover a
// dictionary, UTF-8 encoding, min/max statistics -- that we can skip entirely,
// because D1 already hands us the dictionary: a dim *id* is a perfect key.
//
// So every column is written RLE_DICTIONARY by hand: one pass maps each row's
// id to a dictionary index through an integer-keyed Map, only the distinct
// values are ever UTF-8 encoded, and hyparquet-writer's tested primitives do
// the byte-level work (RLE/bit-packing, Thrift page headers, footer). No
// compression codec: bit-packed indices are already compact and snappy costs
// more CPU than it saves bytes. One row group, one data page per column.

const utf8 = new TextEncoder();
const ELEMENT = {
  day: { name: "day", type: "INT32", repetition_type: "REQUIRED" },
  visitor_id: { name: "visitor_id", type: "INT64", repetition_type: "REQUIRED" },
  dim: (name) => ({ name, type: "BYTE_ARRAY", converted_type: "UTF8", repetition_type: "OPTIONAL" }),
};

// PLAIN BYTE_ARRAY (4-byte LE length + UTF-8) straight into one buffer with
// encodeInto: no per-value Uint8Array allocation, which profiled as the
// single largest cost once the per-row work was gone.
function plainStrings(strings) {
  let cap = 0;
  for (const s of strings) cap += 4 + s.length * 3; // UTF-8 worst case
  const out = new Uint8Array(cap);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const s of strings) {
    const { written } = utf8.encodeInto(s, out.subarray(at + 4));
    view.setUint32(at, written, true);
    at += 4 + written;
  }
  return out.subarray(0, at);
}

function plainValues(values, type) {
  const w = new ByteWriter(values.length * 8 + 16);
  writePlain(w, values, type);
  return w.getBytes();
}

// Write one dictionary-encoded column chunk. `keyAt(i)` returns row i's
// dictionary key (null = NULL, OPTIONAL columns only); `valueOf(key)` returns
// the value to store for a key (a JS string for BYTE_ARRAY), and is called
// once per distinct key.
function writeDictColumn(writer, element, n, keyAt, valueOf) {
  const optional = element.repetition_type === "OPTIONAL";
  const indexOf = new Map();
  const dictionary = [];
  const indexes = new Int32Array(n);
  const defLevels = optional ? new Uint8Array(n) : null;
  let count = 0;
  let minKey = null;
  let maxKey = null;
  for (let i = 0; i < n; i += 1) {
    const key = keyAt(i);
    if (key === null) continue; // defLevels[i] stays 0
    if (optional) defLevels[i] = 1;
    let k = indexOf.get(key);
    if (k === undefined) {
      k = dictionary.length;
      dictionary.push(valueOf(key));
      indexOf.set(key, k);
      if (!optional) {
        if (minKey === null || key < minKey) minKey = key;
        if (maxKey === null || key > maxKey) maxKey = key;
      }
    }
    indexes[count++] = k;
  }

  const chunkStart = writer.offset;

  // Dictionary page: the distinct values, PLAIN.
  const dictionary_page_offset = BigInt(writer.offset);
  const dictBytes = element.type === "BYTE_ARRAY" ? plainStrings(dictionary) : plainValues(dictionary, element.type);
  writePageHeader(writer, {
    type: "DICTIONARY_PAGE",
    uncompressed_page_size: dictBytes.length,
    compressed_page_size: dictBytes.length,
    dictionary_page_header: { num_values: dictionary.length, encoding: "PLAIN" },
  });
  writer.appendBytes(dictBytes);

  // Data page v2: definition levels (uncompressed, RLE), then the indices.
  const data_page_offset = BigInt(writer.offset);
  const levels = new ByteWriter();
  const definition_levels_byte_length = optional ? writeRleBitPackedHybrid(levels, defLevels, 1) : 0;
  const data = new ByteWriter();
  // bitWidth >= 1: a 0-width run is legal but not every reader accepts it.
  const bitWidth = Math.max(1, Math.ceil(Math.log2(dictionary.length)));
  data.appendUint8(bitWidth);
  writeRleBitPackedHybrid(data, indexes.subarray(0, count), bitWidth);
  writePageHeader(writer, {
    type: "DATA_PAGE_V2",
    uncompressed_page_size: levels.offset + data.offset,
    compressed_page_size: levels.offset + data.offset,
    data_page_header_v2: {
      num_values: n,
      num_nulls: n - count,
      num_rows: n,
      encoding: "RLE_DICTIONARY",
      definition_levels_byte_length,
      repetition_levels_byte_length: 0,
      is_compressed: false,
    },
  });
  writer.appendBytes(levels.getBytes());
  writer.appendBytes(data.getBytes());

  const size = BigInt(writer.offset - chunkStart);
  return {
    file_offset: BigInt(chunkStart),
    meta_data: {
      type: element.type,
      encodings: ["PLAIN", "RLE", "RLE_DICTIONARY"],
      path_in_schema: [element.name],
      codec: "UNCOMPRESSED",
      num_values: BigInt(n),
      total_uncompressed_size: size,
      total_compressed_size: size,
      data_page_offset,
      dictionary_page_offset,
      // min/max only on the REQUIRED numeric columns: `day` is what readers
      // prune on, and string min/max would cost a compare per distinct value.
      statistics: optional
        ? { null_count: BigInt(n - count) }
        : n
          ? { null_count: 0n, min_value: valueOf(minKey), max_value: valueOf(maxKey) }
          : { null_count: 0n },
    },
  };
}

// rows: arrays in FACT_COLUMNS order. dimMaps: one id->value Map per dimension,
// in DIMENSIONS order. Returns the Parquet file bytes.
export function encodeEvents(rows, dimMaps, { timezone = "", site = "" } = {}) {
  const n = rows.length;
  const writer = new ByteWriter(64 * 1024);
  writer.appendUint32(PARQUET_MAGIC);
  const columns = [
    writeDictColumn(writer, ELEMENT.day, n, (i) => rows[i][0], (v) => v),
    writeDictColumn(writer, ELEMENT.visitor_id, n, (i) => rows[i][1], (v) => BigInt(v)),
  ];
  DIMENSION_NAMES.forEach((name, j) => {
    const map = dimMaps[j];
    columns.push(
      writeDictColumn(
        writer,
        ELEMENT.dim(name),
        n,
        (i) => rows[i][2 + j],
        (id) => {
          const value = map.get(id);
          // Dim rows are never deleted, so a miss is a bug -- fail loudly rather
          // than silently archiving the event as "(unknown)".
          if (value === undefined) throw new Error(`archive: no ${name} value for id ${id}`);
          return value;
        }
      )
    );
  });

  const schema = [
    { name: "root", num_children: 2 + DIMENSION_NAMES.length },
    ELEMENT.day,
    ELEMENT.visitor_id,
    ...DIMENSION_NAMES.map(ELEMENT.dim),
  ];
  writeMetadata(writer, {
    version: 2,
    created_by: "cloudflare-stats-worker",
    schema,
    num_rows: BigInt(n),
    row_groups: [{ columns, total_byte_size: BigInt(writer.offset - 4), num_rows: BigInt(n) }],
    key_value_metadata: [
      { key: "schema_version", value: ARCHIVE_SCHEMA_VERSION },
      { key: "timezone", value: timezone },
      { key: "site", value: site },
    ],
  });
  writer.appendUint32(PARQUET_MAGIC);
  return new Uint8Array(writer.getBuffer());
}
