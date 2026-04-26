/**
 * Run manifest: a single buy-planning input set (orders + price lists + chats).
 *
 * The "corpus" is shared across demo days:
 *   data/price_lists/        — every supplier_DATE file, deduped
 *   data/supplier_chat_logs/ — one cumulative log per supplier (latest)
 *   data/orders/<date>.csv   — orders per delivery day
 *   data/demo_days.json      — { "<date>": { delivery_date, doc_ids[] } }
 *
 * Each demo day is a pointer: which doc_ids were on disk that morning + which
 * orders CSV to load. Chat logs are date-filtered at agent-tool read time
 * (each line begins with [YYYY-MM-DD, ...]).
 *
 * Drag-drop uploads stage under data/runs/<run_id>/sources/* and re-runs
 * overwrite — never touches the shared corpus or per-day fixtures.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(__dirname, "..");
export const REPO_ROOT = resolve(APP_ROOT, "..");

export const CORPUS_PRICE_LISTS = join(REPO_ROOT, "data", "price_lists");
export const CORPUS_CHAT_LOGS = join(REPO_ROOT, "data", "supplier_chat_logs");
export const CORPUS_ORDERS = join(REPO_ROOT, "data", "orders");
export const DEMO_DAYS_PATH = join(REPO_ROOT, "data", "demo_days.json");

export const PRE_BAKED_EXTRACTIONS = join(APP_ROOT, "data", "extractions");
export const PRE_BAKED_INDEX = join(APP_ROOT, "data", "coarse_offerings.json");
export const RUNS_DIR = join(APP_ROOT, "data", "runs");

export type DemoDay = { delivery_date: string; doc_ids: string[] };
export type DemoDays = Record<string, DemoDay>;

export type OrderLine = {
  id: number;
  name: string;
  description: string;
  quantity: number;
  n_orders: number;
};

export type PriceListFile = {
  filename: string;
  supplier: string;
  date: string;
  format: "pdf" | "txt" | "csv";
  source_path: string;
  extracted: boolean;
  row_count: number | null;
};

export type ChatLogFile = {
  filename: string;
  supplier: string;
  date_range: string;
  source_path: string;
  bytes: number;
};

export type RunManifest = {
  run_id: string;
  source_kind: "sample" | "upload";
  delivery_date: string;
  created_at: string;
  orders: { source_path: string; lines: OrderLine[] };
  price_lists: PriceListFile[];
  chat_logs: ChatLogFile[];
  has_index: boolean;
  index_path: string;
};

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

function readExtractionRowCount(doc_id: string): number | null {
  const path = join(PRE_BAKED_EXTRACTIONS, `${doc_id}.json`);
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, "utf-8")) as {
      row_count?: number;
      error?: string;
    };
    if (doc.error) return null;
    return doc.row_count ?? null;
  } catch {
    return null;
  }
}

function findPriceListFile(doc_id: string): { filename: string; format: "pdf" | "txt" | "csv" } | null {
  for (const ext of ["pdf", "csv", "txt"] as const) {
    const f = `${doc_id}.${ext}`;
    if (existsSync(join(CORPUS_PRICE_LISTS, f))) return { filename: f, format: ext };
  }
  return null;
}

export function loadDemoDays(): DemoDays {
  if (!existsSync(DEMO_DAYS_PATH)) {
    throw new Error(`demo_days.json not found at ${DEMO_DAYS_PATH}`);
  }
  return JSON.parse(readFileSync(DEMO_DAYS_PATH, "utf-8")) as DemoDays;
}

export function loadSampleManifest(day: string): RunManifest {
  const days = loadDemoDays();
  const dayMeta = days[day];
  if (!dayMeta) {
    throw new Error(`unknown demo day: ${day} (have ${Object.keys(days).join(", ")})`);
  }

  const ordersPath = join(CORPUS_ORDERS, `${day}.csv`);
  if (!existsSync(ordersPath)) {
    throw new Error(`orders file missing: ${ordersPath}`);
  }
  const orders = parseOrdersCsv(readFileSync(ordersPath, "utf-8"));

  const price_lists: PriceListFile[] = [];
  for (const doc_id of dayMeta.doc_ids) {
    const meta = parsePriceListFilename(`${doc_id}.pdf`) ??
      parsePriceListFilename(`${doc_id}.csv`) ??
      parsePriceListFilename(`${doc_id}.txt`);
    if (!meta) continue;
    const found = findPriceListFile(doc_id);
    if (!found) continue;
    const row_count = readExtractionRowCount(doc_id);
    price_lists.push({
      filename: found.filename,
      supplier: meta.supplier,
      date: meta.date,
      format: found.format,
      source_path: join(CORPUS_PRICE_LISTS, found.filename),
      extracted: row_count !== null,
      row_count,
    });
  }

  const chat_logs: ChatLogFile[] = [];
  if (existsSync(CORPUS_CHAT_LOGS)) {
    for (const f of readdirSync(CORPUS_CHAT_LOGS).sort()) {
      const meta = parseChatLogFilename(f);
      if (!meta) continue;
      const fullPath = join(CORPUS_CHAT_LOGS, f);
      chat_logs.push({
        filename: f,
        supplier: meta.supplier,
        date_range: meta.date_range,
        source_path: fullPath,
        bytes: statSync(fullPath).size,
      });
    }
  }

  return {
    run_id: `sample-${day}`,
    source_kind: "sample",
    delivery_date: dayMeta.delivery_date,
    created_at: new Date().toISOString(),
    orders: { source_path: ordersPath, lines: orders },
    price_lists,
    chat_logs,
    has_index: existsSync(PRE_BAKED_INDEX),
    index_path: PRE_BAKED_INDEX,
  };
}
