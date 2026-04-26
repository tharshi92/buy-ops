/**
 * Harness CLI: process one PDF end-to-end through the pipeline.
 *
 * Usage:
 *   npm run harness -- <pdf-path> [--today YYYY-MM-DD] [--no-repair] [--stage1-only]
 *
 * Output:
 *   runs/<timestamp>_<filename>.audit.json
 *   runs/<timestamp>_<filename>.canonical.json
 */

import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline } from "./orchestrator.js";
import { loadCatalog } from "./catalog.js";
import { writeAuditRecord, ensureDir } from "./audit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_ROOT = resolve(__dirname, "..");
const RUNS_DIR = join(PIPELINE_ROOT, "runs");
const CATALOG_PATH = resolve(PIPELINE_ROOT, "..", "products.csv");

interface Args {
  pdfPath: string;
  today?: string;
  noRepair: boolean;
  stage1Only: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let today: string | undefined;
  let noRepair = false;
  let stage1Only = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--today") {
      today = argv[++i];
    } else if (a === "--no-repair") {
      noRepair = true;
    } else if (a === "--stage1-only") {
      stage1Only = true;
    } else if (a.startsWith("--")) {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    } else {
      positional.push(a);
    }
  }

  if (positional.length === 0) {
    console.error("Usage: npm run harness -- <pdf-path> [--today YYYY-MM-DD] [--no-repair] [--stage1-only]");
    process.exit(2);
  }

  return {
    pdfPath: resolve(positional[0]!),
    today,
    noRepair,
    stage1Only,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.pdfPath)) {
    console.error(`PDF not found: ${args.pdfPath}`);
    process.exit(1);
  }
  if (!existsSync(CATALOG_PATH)) {
    console.error(`Catalog not found: ${CATALOG_PATH}`);
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set. Copy .env.example to .env and add your key.");
    process.exit(1);
  }

  console.log(`[harness] PDF: ${args.pdfPath}`);
  console.log(`[harness] Catalog: ${CATALOG_PATH}`);
  console.log(`[harness] Loading catalog...`);
  const catalog = loadCatalog(CATALOG_PATH);
  console.log(`[harness] Catalog loaded: ${catalog.count} products (version ${catalog.versionHash}).`);

  const t0 = performance.now();
  const record = await runPipeline({
    pdfPath: args.pdfPath,
    catalog,
    todayISODate: args.today,
    maxRepairIterations: args.noRepair ? 0 : undefined,
    skipStage2: args.stage1Only,
  });
  const wallMs = Math.round(performance.now() - t0);

  ensureDir(RUNS_DIR);
  const { auditPath, canonicalPath } = writeAuditRecord(record, RUNS_DIR);

  // ---- summary ----
  console.log("");
  console.log("===== run summary =====");
  console.log(`status:                ${record.status}`);
  console.log(`audit_id:              ${record.audit_id}`);
  console.log(`document_id:           ${record.document_id}`);
  console.log(`supplier (extracted):  ${record.final.supplier.name ?? "(null)"}`);
  console.log(`effective_dates:       start=${record.final.effective_dates.effective_start ?? "null"} end=${record.final.effective_dates.effective_end ?? "null"} (source=${record.final.effective_dates.source})`);
  console.log(`canonical rows:        ${record.final.canonical_rows.length}`);
  console.log(`stage1 iterations:     ${record.metrics.iteration_count.stage1} (${record.stage1.final_status})`);
  console.log(`stage2 iterations:     ${record.metrics.iteration_count.stage2} (${record.stage2.final_status})`);
  console.log(`total API calls:       ${record.metrics.total_calls}`);
  console.log(`total input tokens:    ${record.metrics.total_input_tokens.toLocaleString()}`);
  console.log(`total output tokens:   ${record.metrics.total_output_tokens.toLocaleString()}`);
  console.log(`cache read tokens:     ${record.metrics.total_cache_read_tokens.toLocaleString()}`);
  console.log(`cache create tokens:   ${record.metrics.total_cache_creation_tokens.toLocaleString()}`);
  console.log(`wall clock:            ${(wallMs / 1000).toFixed(1)}s`);
  if (record.notes.length > 0) {
    console.log(`notes:`);
    for (const n of record.notes) console.log(`  - ${n}`);
  }
  console.log("");
  console.log(`audit:     ${auditPath}`);
  console.log(`canonical: ${canonicalPath}`);
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
