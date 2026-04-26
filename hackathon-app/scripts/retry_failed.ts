/**
 * Re-run extraction for any per-doc artifacts that have an error field.
 * Useful for transient failures (rate-limit blips, etc).
 *
 * Run: npx tsx scripts/retry_failed.ts
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFromFile } from "../src/extract.js";
import type { ExtractionDoc } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");
const EXTRACTIONS_DIR = join(APP_ROOT, "data", "extractions");

async function main() {
  const files = readdirSync(EXTRACTIONS_DIR).filter((f) => f.endsWith(".json"));
  const failed: ExtractionDoc[] = [];
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(EXTRACTIONS_DIR, f), "utf-8")) as ExtractionDoc;
    if (doc.error || doc.row_count === 0) failed.push(doc);
  }
  console.log(`[retry] found ${failed.length} failed doc(s):`);
  for (const d of failed) console.log(`  - ${d.doc_id}.${d.format}: ${d.error?.slice(0, 100)}`);
  console.log("");

  const additional_dirs = ["/Users/tharshi/GitHub/builtwithopus47/buy-ops/data"];
  for (const old of failed) {
    console.log(`[retry] → ${old.doc_id}`);
    const fresh = await extractFromFile({
      doc_id: old.doc_id,
      supplier: old.supplier,
      date: old.date,
      source_path: old.source_path,
      format: old.format,
      additional_dirs,
    });
    writeFileSync(
      join(EXTRACTIONS_DIR, `${old.doc_id}.json`),
      JSON.stringify(fresh, null, 2),
    );
    if (fresh.error) {
      console.log(`[retry] ✗ ${old.doc_id} — ${fresh.error.slice(0, 120)} (${fresh.duration_ms}ms)`);
    } else {
      console.log(`[retry] ✓ ${old.doc_id} — ${fresh.row_count} rows (${fresh.duration_ms}ms)`);
    }
  }
}

main().catch((e) => {
  console.error("[retry] threw:", e);
  process.exit(2);
});
