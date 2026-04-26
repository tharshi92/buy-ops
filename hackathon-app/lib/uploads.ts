/**
 * Drag-drop ingestion. Files are bucketed by name pattern:
 *   - `ordered_items_*.csv` → orders
 *   - `supplier-{x}-{date}.{pdf|csv|txt}` → price_lists
 *   - `supplier-{x}_{from}_to_{to}.txt` → chat_logs
 *
 * Each upload session gets a fresh run_id. Files land under
 *   data/runs/<run_id>/sources/{orders,price_lists,supplier_chat_logs}/
 *
 * Idempotent: re-uploading the same filename to the same run_id overwrites it.
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { RUNS_DIR, type RunManifest, type OrderLine, type PriceListFile, type ChatLogFile } from "./runs";

export type UploadBucket = "orders" | "price_lists" | "chat_logs" | "unknown";

export function bucketForFilename(filename: string): UploadBucket {
  if (/^ordered_items_.*\.csv$/i.test(filename)) return "orders";
  if (/^supplier-[a-z](?:-pt\d+)?-\d{4}-\d{2}-\d{2}\.(pdf|csv|txt)$/i.test(filename))
    return "price_lists";
  if (/^supplier-[a-z]_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.txt$/i.test(filename))
    return "chat_logs";
  return "unknown";
}

export function newRunId(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rand = randomBytes(3).toString("hex");
  return `upload-${ts}-${rand}`;
}

export function runDirsFor(run_id: string) {
  const root = join(RUNS_DIR, run_id);
  return {
    root,
    orders: join(root, "sources", "orders"),
    price_lists: join(root, "sources", "price_lists"),
    chat_logs: join(root, "sources", "supplier_chat_logs"),
    extractions: join(root, "extractions"),
    index: join(root, "coarse_offerings.json"),
  };
}

export function ensureRunDirs(run_id: string) {
  const dirs = runDirsFor(run_id);
  for (const d of [dirs.orders, dirs.price_lists, dirs.chat_logs, dirs.extractions]) {
    mkdirSync(d, { recursive: true });
  }
  return dirs;
}

export type StagedFile = {
  filename: string;
  bucket: UploadBucket;
  bytes: number;
  saved_path: string;
};

export async function stageUploadedFiles(
  run_id: string,
  files: File[],
): Promise<StagedFile[]> {
  const dirs = ensureRunDirs(run_id);
  const out: StagedFile[] = [];
  for (const file of files) {
    const bucket = bucketForFilename(file.name);
    const targetDir = bucket === "unknown" ? dirs.root : dirs[bucket];
    const targetPath = join(targetDir, file.name);
    const buf = Buffer.from(await file.arrayBuffer());
    writeFileSync(targetPath, buf);
    out.push({
      filename: file.name,
      bucket,
      bytes: buf.byteLength,
      saved_path: targetPath,
    });
  }
  return out;
}

function parseOrdersCsv(csv: string): OrderLine[] {
  const lines = csv.trim().split(/\r?\n/);
  const out: OrderLine[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(",");
    if (cells.length < 6) continue;
    out.push({
      id: parseInt(cells[1] ?? "0", 10),
      name: cells[2] ?? "",
      description: cells[3] ?? "",
      quantity: parseInt(cells[4] ?? "0", 10),
      n_orders: parseInt(cells[5] ?? "0", 10),
    });
  }
  return out;
}

function parsePriceListFilename(filename: string) {
  const ext = extname(filename).toLowerCase();
  if (ext !== ".pdf" && ext !== ".txt" && ext !== ".csv") return null;
  const stem = filename.slice(0, filename.length - ext.length);
  const m = stem.match(/^(supplier-[a-z](?:-pt\d+)?)-(\d{4}-\d{2}-\d{2})$/);
  if (!m) return null;
  return {
    supplier: m[1]!,
    date: m[2]!,
    format: ext.slice(1) as "pdf" | "txt" | "csv",
  };
}

function parseChatLogFilename(filename: string) {
  if (!filename.endsWith(".txt")) return null;
  const stem = filename.slice(0, -4);
  const m = stem.match(/^(supplier-[a-z])_(\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2})$/);
  if (!m) return null;
  return { supplier: m[1]!, date_range: m[2]! };
}

export function buildRunManifestFromDisk(run_id: string): RunManifest {
  const dirs = runDirsFor(run_id);
  if (!existsSync(dirs.root)) throw new Error(`run ${run_id} not found`);

  let orders: OrderLine[] = [];
  let ordersPath = "";
  if (existsSync(dirs.orders)) {
    const ordersFiles = readdirSync(dirs.orders).filter((f) => f.endsWith(".csv"));
    if (ordersFiles[0]) {
      ordersPath = join(dirs.orders, ordersFiles[0]);
      orders = parseOrdersCsv(readFileSync(ordersPath, "utf-8"));
    }
  }

  const price_lists: PriceListFile[] = [];
  if (existsSync(dirs.price_lists)) {
    for (const f of readdirSync(dirs.price_lists).sort()) {
      const meta = parsePriceListFilename(f);
      if (!meta) continue;
      const doc_id = f.slice(0, f.length - extname(f).length);
      const extractedPath = join(dirs.extractions, `${doc_id}.json`);
      let row_count: number | null = null;
      let extracted = false;
      if (existsSync(extractedPath)) {
        try {
          const doc = JSON.parse(readFileSync(extractedPath, "utf-8")) as {
            row_count?: number;
            error?: string;
          };
          if (!doc.error) {
            extracted = true;
            row_count = doc.row_count ?? null;
          }
        } catch {
          // ignore parse errors — leave as not extracted
        }
      }
      price_lists.push({
        filename: f,
        supplier: meta.supplier,
        date: meta.date,
        format: meta.format,
        source_path: join(dirs.price_lists, f),
        extracted,
        row_count,
      });
    }
  }

  const chat_logs: ChatLogFile[] = [];
  if (existsSync(dirs.chat_logs)) {
    for (const f of readdirSync(dirs.chat_logs).sort()) {
      const meta = parseChatLogFilename(f);
      if (!meta) continue;
      const fullPath = join(dirs.chat_logs, f);
      chat_logs.push({
        filename: f,
        supplier: meta.supplier,
        date_range: meta.date_range,
        source_path: fullPath,
        bytes: statSync(fullPath).size,
      });
    }
  }

  // Best-guess delivery_date: from orders filename or today
  let delivery_date = new Date().toISOString().slice(0, 10);
  if (ordersPath) {
    const m = ordersPath.match(/ordered_items_(\d{4}-\d{2}-\d{2})\.csv$/);
    if (m) delivery_date = m[1]!;
  }

  return {
    run_id,
    source_kind: "upload",
    delivery_date,
    created_at: new Date().toISOString(),
    orders: { source_path: ordersPath, lines: orders },
    price_lists,
    chat_logs,
    has_index: existsSync(dirs.index),
    index_path: dirs.index,
  };
}
