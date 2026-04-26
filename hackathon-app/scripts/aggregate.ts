/**
 * Re-aggregate per-doc extraction artifacts into the commodity-keyed
 * coarse_offerings.json. Computes effective_start / effective_end from the
 * doc dates per supplier (no LLM calls — cheap and deterministic).
 *
 * Run: npx tsx scripts/aggregate.ts
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoarseOfferings, CoarseRow, ExtractionDoc } from "../src/types.js";
import type { CanonicalizationMap } from "../src/canonicalize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");
const EXTRACTIONS_DIR = join(APP_ROOT, "data", "extractions");
const INDEX_PATH = join(APP_ROOT, "data", "coarse_offerings.json");
const CANON_PATH = join(APP_ROOT, "data", "commodity_canonicalization.json");

function dayBefore(yyyymmdd: string): string {
  const d = new Date(yyyymmdd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function main() {
  const files = readdirSync(EXTRACTIONS_DIR).filter((f) => f.endsWith(".json"));
  const docs: ExtractionDoc[] = [];
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(EXTRACTIONS_DIR, f), "utf-8")) as ExtractionDoc;
    if (doc.error || doc.row_count === 0) continue;
    docs.push(doc);
  }
  console.log(`[aggregate] loaded ${docs.length} successful per-doc extractions`);

  // Compute effective_start / effective_end per doc
  const docsBySupplier = new Map<string, ExtractionDoc[]>();
  for (const doc of docs) {
    const arr = docsBySupplier.get(doc.supplier) ?? [];
    if (arr.length === 0) docsBySupplier.set(doc.supplier, arr);
    arr.push(doc);
  }
  const effectiveByDocId = new Map<string, { start: string; end: string | null }>();
  for (const [supplier, supDocs] of docsBySupplier) {
    const distinctDates = Array.from(new Set(supDocs.map((d) => d.date))).sort();
    for (const doc of supDocs) {
      const i = distinctDates.indexOf(doc.date);
      const nextDate =
        i >= 0 && i < distinctDates.length - 1 ? distinctDates[i + 1]! : null;
      effectiveByDocId.set(doc.doc_id, {
        start: doc.date,
        end: nextDate ? dayBefore(nextDate) : null,
      });
    }
    if (distinctDates.length > 1) {
      console.log(`  [${supplier}] ${distinctDates.length} dates: ${distinctDates.join(", ")}`);
    }
  }

  // Load canonicalization map if present
  const canonOf = new Map<string, string>();
  if (existsSync(CANON_PATH)) {
    const map = JSON.parse(readFileSync(CANON_PATH, "utf-8")) as CanonicalizationMap;
    for (const m of map.merges) canonOf.set(m.source, m.canonical);
    console.log(`[aggregate] loaded ${map.merges.length} canonicalization rule(s)`);
  } else {
    console.log(`[aggregate] no canonicalization map found — commodities used as-is`);
  }

  // Build commodity-keyed index
  const offerings: CoarseOfferings = {};
  for (const doc of docs) {
    const eff = effectiveByDocId.get(doc.doc_id)!;
    doc.rows.forEach((row, row_idx) => {
      const commodity = canonOf.get(row.commodity) ?? row.commodity;
      const full: CoarseRow = {
        doc_id: doc.doc_id,
        supplier: doc.supplier,
        effective_start: eff.start,
        effective_end: eff.end,
        row_idx,
        commodity,
        cost: row.cost,
        raw_row_text: row.raw_row_text,
      };
      (offerings[commodity] ??= []).push(full);
    });
  }

  // Sort each commodity's rows: most recent first, then doc_id, then row_idx
  for (const c of Object.keys(offerings)) {
    offerings[c]!.sort((a, b) => {
      if (b.effective_start !== a.effective_start)
        return b.effective_start.localeCompare(a.effective_start);
      if (a.doc_id !== b.doc_id) return a.doc_id.localeCompare(b.doc_id);
      return a.row_idx - b.row_idx;
    });
  }

  writeFileSync(INDEX_PATH, JSON.stringify(offerings, null, 2));

  const counts = Object.entries(offerings)
    .map(([c, rs]) => ({ c, n: rs.length }))
    .sort((a, b) => b.n - a.n);
  const totalRows = counts.reduce((s, x) => s + x.n, 0);
  console.log(`\n[aggregate] wrote ${INDEX_PATH}`);
  console.log(`[aggregate]   ${Object.keys(offerings).length} distinct commodities, ${totalRows} total rows`);
  console.log(`[aggregate] top 15 commodities by row count:`);
  for (const { c, n } of counts.slice(0, 15)) {
    console.log(`            ${n.toString().padStart(4)}  ${c}`);
  }
}

main();
