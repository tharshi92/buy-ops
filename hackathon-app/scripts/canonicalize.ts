/**
 * Run the commodity canonicalizer over the current per-doc extractions.
 * Writes data/commodity_canonicalization.json. aggregate.ts will pick this
 * up automatically on the next run.
 *
 * Run: npx tsx scripts/canonicalize.ts
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "../src/canonicalize.js";
import type { ExtractionDoc } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");
const EXTRACTIONS_DIR = join(APP_ROOT, "data", "extractions");
const MAP_PATH = join(APP_ROOT, "data", "commodity_canonicalization.json");

async function main() {
  const files = readdirSync(EXTRACTIONS_DIR).filter((f) => f.endsWith(".json"));
  const counts = new Map<string, number>();
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(EXTRACTIONS_DIR, f), "utf-8")) as ExtractionDoc;
    if (doc.error || doc.row_count === 0) continue;
    for (const r of doc.rows) {
      counts.set(r.commodity, (counts.get(r.commodity) ?? 0) + 1);
    }
  }
  const list = Array.from(counts.entries()).map(([name, row_count]) => ({
    name,
    row_count,
  }));
  console.log(`[canon] ${list.length} distinct commodities; calling Opus...`);

  const t0 = Date.now();
  const map = await canonicalize(list);
  const dur = Date.now() - t0;

  writeFileSync(MAP_PATH, JSON.stringify(map, null, 2));

  console.log(`[canon] wrote ${MAP_PATH} (${(dur / 1000).toFixed(1)}s)`);
  console.log(`[canon] ${map.merges.length} merge rule(s):`);
  // Group by canonical for readable output
  const byCanon = new Map<string, typeof map.merges>();
  for (const m of map.merges) {
    const arr = byCanon.get(m.canonical) ?? [];
    if (arr.length === 0) byCanon.set(m.canonical, arr);
    arr.push(m);
  }
  for (const [canonical, ms] of Array.from(byCanon.entries()).sort()) {
    console.log(`  → ${canonical}`);
    for (const m of ms) {
      console.log(`        ${m.source.padEnd(30)} (${m.reason})`);
    }
  }
}

main().catch((e) => {
  console.error("[canon] threw:", e);
  process.exit(2);
});
