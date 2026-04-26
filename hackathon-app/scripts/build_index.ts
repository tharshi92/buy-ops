/**
 * Phase 1 — coarse extraction over all 24 supplier price lists.
 *
 * Runs extractFromFile() in a bounded promise pool, persists per-doc
 * extractions to data/extractions/<doc_id>.json, then aggregates into
 * data/coarse_offerings.json keyed by commodity.
 *
 * Run: npx tsx scripts/build_index.ts [--concurrency N]
 */

import { readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFromFile } from "../src/extract.js";
import type { CoarseOfferings, CoarseRow, ExtractionDoc } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");
const DATA_OUT = join(APP_ROOT, "data");
const EXTRACTIONS_DIR = join(DATA_OUT, "extractions");
const INDEX_PATH = join(DATA_OUT, "coarse_offerings.json");
const PRICE_LISTS_DIR =
  "/Users/tharshi/GitHub/builtwithopus47/buy-ops/data/price_lists";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) {
    args.set(a.slice(2), process.argv[++i] ?? "");
  }
}
const CONCURRENCY = parseInt(args.get("concurrency") ?? "6", 10);

interface FileMeta {
  doc_id: string;
  supplier: string;
  date: string;
  source_path: string;
  format: "pdf" | "txt" | "csv";
}

function discoverFiles(): FileMeta[] {
  const all = readdirSync(PRICE_LISTS_DIR).filter((f) =>
    /\.(pdf|csv|txt)$/i.test(f),
  );

  // For supplier-X-DATE.pdf vs supplier-X-DATE.redacted.pdf, prefer the redacted.
  const skip = new Set<string>();
  for (const f of all) {
    if (f.endsWith(".redacted.pdf")) {
      skip.add(f.replace(/\.redacted\.pdf$/, ".pdf"));
    }
  }
  const kept = all.filter((f) => !skip.has(f));

  const metas: FileMeta[] = [];
  for (const f of kept) {
    const ext = f.endsWith(".redacted.pdf")
      ? ".redacted.pdf"
      : f.slice(f.lastIndexOf("."));
    const stem = f.slice(0, f.length - ext.length);
    const m = stem.match(/^(supplier-[a-z](?:-pt\d+)?)-(\d{4}-\d{2}-\d{2})$/);
    if (!m) {
      console.warn(`[index] could not parse filename: ${f}`);
      continue;
    }
    const format = (
      ext.endsWith(".pdf") ? "pdf" : ext === ".csv" ? "csv" : "txt"
    ) as "pdf" | "txt" | "csv";
    metas.push({
      doc_id: stem,
      supplier: m[1]!,
      date: m[2]!,
      source_path: join(PRICE_LISTS_DIR, f),
      format,
    });
  }
  return metas;
}

async function pool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

async function main() {
  if (!existsSync(EXTRACTIONS_DIR)) mkdirSync(EXTRACTIONS_DIR, { recursive: true });

  const files = discoverFiles();
  console.log(
    `[index] discovered ${files.length} files (concurrency=${CONCURRENCY})`,
  );
  for (const f of files) {
    console.log(`  - ${f.doc_id}.${f.format}`);
  }
  console.log("");

  const t0 = Date.now();
  const additional_dirs = ["/Users/tharshi/GitHub/builtwithopus47/buy-ops/data"];

  const docs = await pool(files, CONCURRENCY, async (meta, i) => {
    const tag = `[${(i + 1).toString().padStart(2)}/${files.length}]`;
    console.log(`${tag} → start ${meta.doc_id}.${meta.format}`);
    const doc = await extractFromFile({ ...meta, additional_dirs });
    if (doc.error) {
      console.log(
        `${tag} ✗ ${meta.doc_id} — ${doc.error.slice(0, 120)}  (${doc.duration_ms}ms)`,
      );
    } else {
      console.log(
        `${tag} ✓ ${meta.doc_id} — ${doc.row_count} rows (${doc.duration_ms}ms)`,
      );
    }
    // Persist per-doc extraction immediately (so partial failures still leave artifacts)
    writeFileSync(
      join(EXTRACTIONS_DIR, `${meta.doc_id}.json`),
      JSON.stringify(doc, null, 2),
    );
    return doc;
  });

  console.log("");
  const totalMs = Date.now() - t0;
  const ok = docs.filter((d) => !d.error);
  const err = docs.filter((d) => d.error);
  console.log(`[index] extraction complete in ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`[index]   ${ok.length} succeeded, ${err.length} failed`);

  // Compute effective_start / effective_end per doc:
  //   effective_start = doc.date (the publication date in the filename)
  //   effective_end   = (next-newer same-supplier doc.date − 1 day), or null if newest
  const docsBySupplier = new Map<string, ExtractionDoc[]>();
  for (const doc of ok) {
    (docsBySupplier.get(doc.supplier) ?? docsBySupplier.set(doc.supplier, []).get(doc.supplier)!)
      .push(doc);
  }
  const dayBefore = (yyyymmdd: string): string => {
    const d = new Date(yyyymmdd + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const effectiveByDocId = new Map<string, { start: string; end: string | null }>();
  for (const [, docs] of docsBySupplier) {
    // unique sorted ascending list of distinct dates for this supplier
    const distinctDates = Array.from(new Set(docs.map((d) => d.date))).sort();
    for (const doc of docs) {
      const i = distinctDates.indexOf(doc.date);
      const nextDate = i >= 0 && i < distinctDates.length - 1 ? distinctDates[i + 1]! : null;
      effectiveByDocId.set(doc.doc_id, {
        start: doc.date,
        end: nextDate ? dayBefore(nextDate) : null,
      });
    }
  }

  // Aggregate into commodity-keyed index
  const offerings: CoarseOfferings = {};
  for (const doc of ok) {
    const eff = effectiveByDocId.get(doc.doc_id)!;
    doc.rows.forEach((row, row_idx) => {
      const full: CoarseRow = {
        doc_id: doc.doc_id,
        supplier: doc.supplier,
        effective_start: eff.start,
        effective_end: eff.end,
        row_idx,
        commodity: row.commodity,
        cost: row.cost,
        raw_row_text: row.raw_row_text,
      };
      (offerings[full.commodity] ??= []).push(full);
    });
  }

  // Sort each commodity's rows by effective_start desc, then doc_id, then row_idx
  for (const c of Object.keys(offerings)) {
    offerings[c]!.sort((a, b) => {
      if (b.effective_start !== a.effective_start)
        return b.effective_start.localeCompare(a.effective_start);
      if (a.doc_id !== b.doc_id) return a.doc_id.localeCompare(b.doc_id);
      return a.row_idx - b.row_idx;
    });
  }

  writeFileSync(INDEX_PATH, JSON.stringify(offerings, null, 2));

  // Summary stats
  const commodityCounts = Object.entries(offerings)
    .map(([c, rs]) => ({ c, n: rs.length }))
    .sort((a, b) => b.n - a.n);
  const totalRows = commodityCounts.reduce((s, x) => s + x.n, 0);
  console.log(`\n[index] wrote ${INDEX_PATH}`);
  console.log(
    `[index]   ${Object.keys(offerings).length} distinct commodities, ${totalRows} total rows`,
  );
  console.log(`[index] top 15 commodities by row count:`);
  for (const { c, n } of commodityCounts.slice(0, 15)) {
    console.log(`           ${n.toString().padStart(4)}  ${c}`);
  }

  if (err.length > 0) {
    console.log(`\n[index] ${err.length} extraction failure(s):`);
    for (const d of err) {
      console.log(`  - ${d.doc_id}.${d.format}: ${d.error}`);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[index] threw:", e);
  process.exit(2);
});
