/**
 * Extract any price-list files in data/price_lists/ that don't yet have a
 * cached extraction in hackathon-app/data/extractions/. Idempotent — files
 * already extracted are skipped.
 *
 * Run: npx tsx scripts/extract_missing.ts [--concurrency N]
 */

import { existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFromFile } from "../src/extract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(APP_ROOT, "..");
const PRICE_LISTS_DIR = join(REPO_ROOT, "data", "price_lists");
const EXTRACTIONS_DIR = join(APP_ROOT, "data", "extractions");

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[++i] ?? "");
}
const CONCURRENCY = parseInt(args.get("concurrency") ?? "4", 10);

type FileMeta = {
  doc_id: string;
  supplier: string;
  date: string;
  source_path: string;
  format: "pdf" | "txt" | "csv";
};

function discover(): FileMeta[] {
  const files = readdirSync(PRICE_LISTS_DIR).filter((f) => /\.(pdf|csv|txt)$/i.test(f));
  const out: FileMeta[] = [];
  for (const f of files) {
    const ext = extname(f).toLowerCase().slice(1) as "pdf" | "txt" | "csv";
    const stem = f.slice(0, f.length - ext.length - 1);
    const m = stem.match(/^(supplier-[a-z](?:-pt\d+)?)-(\d{4}-\d{2}-\d{2})$/);
    if (!m) continue;
    out.push({
      doc_id: stem,
      supplier: m[1]!,
      date: m[2]!,
      source_path: join(PRICE_LISTS_DIR, f),
      format: ext,
    });
  }
  return out;
}

function isCached(doc_id: string): boolean {
  const path = join(EXTRACTIONS_DIR, `${doc_id}.json`);
  if (!existsSync(path)) return false;
  try {
    const doc = JSON.parse(readFileSync(path, "utf-8")) as { error?: string };
    return !doc.error;
  } catch {
    return false;
  }
}

async function pool<T>(items: T[], n: number, fn: (t: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]!, i);
      }
    }),
  );
}

async function main() {
  if (!existsSync(EXTRACTIONS_DIR)) mkdirSync(EXTRACTIONS_DIR, { recursive: true });

  const all = discover();
  const todo = all.filter((m) => !isCached(m.doc_id));
  console.log(`[extract] ${all.length} files in corpus, ${todo.length} need extraction`);
  for (const t of todo) console.log(`  - ${t.doc_id}.${t.format}`);
  if (todo.length === 0) {
    console.log(`[extract] nothing to do`);
    return;
  }

  const additional_dirs = [REPO_ROOT];
  const t0 = Date.now();
  await pool(todo, CONCURRENCY, async (meta, i) => {
    const tag = `[${(i + 1).toString().padStart(2)}/${todo.length}]`;
    console.log(`${tag} → start ${meta.doc_id}.${meta.format}`);
    const doc = await extractFromFile({ ...meta, additional_dirs });
    writeFileSync(join(EXTRACTIONS_DIR, `${meta.doc_id}.json`), JSON.stringify(doc, null, 2));
    if (doc.error) {
      console.log(`${tag} ✗ ${meta.doc_id} — ${doc.error.slice(0, 120)} (${doc.duration_ms}ms)`);
    } else {
      console.log(`${tag} ✓ ${meta.doc_id} — ${doc.row_count} rows (${doc.duration_ms}ms)`);
    }
  });
  console.log(`\n[extract] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error("[extract] threw:", e);
  process.exit(2);
});
