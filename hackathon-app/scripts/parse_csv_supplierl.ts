/**
 * Deterministic parser for supplier-l (Provincial Fruit) CSV format.
 * No LLM, no truncation risk. Output matches ExtractionDoc shape and is
 * written into data/extractions/ alongside LLM-extracted artifacts.
 *
 * Usage:
 *   npx tsx scripts/parse_csv_supplierl.ts <input.csv> [<input2.csv> ...]
 *
 * Notes:
 * - Continuation rows (empty Description) inherit commodity + the leading
 *   commodity word from the most recent non-empty Description row.
 * - raw_row_text = the verbatim CSV line (with trailing commas trimmed).
 * - cost = Price column as number; null if blank or non-numeric.
 * - commodity = first whitespace-token of Description, uppercased and
 *   pluralized (APPLE→APPLES, BANANA→BANANAS, etc.) to match LLM output.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractionDoc } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");
const EXTRACTIONS_DIR = join(APP_ROOT, "data", "extractions");

// Pluralization for common produce words to align with LLM-extracted commodities
const PLURAL: Record<string, string> = {
  APPLE: "APPLES",
  BANANA: "BANANAS",
  GRAPE: "GRAPES",
  ORANGE: "ORANGES",
  LEMON: "LEMONS",
  LIME: "LIMES",
  PEAR: "PEARS",
  PEACH: "PEACHES",
  PLUM: "PLUMS",
  ONION: "ONIONS",
  POTATO: "POTATOES",
  TOMATO: "TOMATOES",
  PEPPER: "PEPPERS",
  CARROT: "CARROTS",
  BEAN: "BEANS",
  BEET: "BEETS",
  CHERRY: "CHERRIES",
  STRAWBERRY: "STRAWBERRIES",
  RASPBERRY: "RASPBERRIES",
  BLUEBERRY: "BLUEBERRIES",
  BLACKBERRY: "BLACKBERRIES",
  MELON: "MELONS",
  MANGO: "MANGOES",
  MUSHROOM: "MUSHROOMS",
  AVOCADO: "AVOCADOS",
  CUCUMBER: "CUCUMBERS",
  EGGPLANT: "EGGPLANTS",
  ZUCCHINI: "ZUCCHINI",
  RADISH: "RADISHES",
  TANGERINE: "TANGERINES",
  CLEMENTINE: "CLEMENTINES",
  GRAPEFRUIT: "GRAPEFRUITS",
  POMEGRANATE: "POMEGRANATES",
  KIWI: "KIWIS",
  PINEAPPLE: "PINEAPPLES",
  PAPAYA: "PAPAYAS",
  COCONUT: "COCONUTS",
  HERB: "HERBS",
  CHILI: "CHILIES",
};

function normalizeCommodity(firstWord: string): string {
  const w = firstWord.trim().toUpperCase().replace(/[^A-Z]/g, "");
  return PLURAL[w] ?? w;
}

// Minimal CSV row split that handles quoted fields with commas.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseFile(csvPath: string): ExtractionDoc {
  const t0 = Date.now();
  const fname = basename(csvPath);
  const stem = fname.replace(/\.csv$/, "");
  const m = stem.match(/^(supplier-[a-z](?:-pt\d+)?)-(\d{4}-\d{2}-\d{2})$/);
  if (!m) throw new Error(`unexpected filename: ${fname}`);
  const supplier = m[1]!;
  const date = m[2]!;

  const text = readFileSync(csvPath, "utf-8");
  const lines = text.split(/\r?\n/);

  const rows: ExtractionDoc["rows"] = [];
  let curCommodity = "";
  let headerSeen = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    if (cells.length < 4) continue;

    // Header detection
    if (!headerSeen) {
      if (cells[0]!.trim().toLowerCase() === "description") {
        headerSeen = true;
      }
      continue; // skip pre-header rows (title row etc.)
    }

    const description = cells[0]!.trim();
    const variantCode = cells[1]!.trim();
    const priceStr = cells[2]!.trim();
    const brand = cells[3]!.trim();

    if (description) {
      const firstWord = description.split(/\s+/)[0] ?? "";
      curCommodity = normalizeCommodity(firstWord);
    }
    // continuation rows (empty description) inherit curCommodity
    if (!curCommodity) continue;

    let cost: number | null = null;
    const num = parseFloat(priceStr);
    if (!Number.isNaN(num) && priceStr !== "") cost = num;

    // raw_row_text: trim trailing empty cells, join with commas (verbatim)
    let lastNonEmpty = cells.length - 1;
    while (lastNonEmpty >= 0 && cells[lastNonEmpty]!.trim() === "") lastNonEmpty--;
    const trimmed = cells.slice(0, lastNonEmpty + 1).join(",");

    rows.push({
      commodity: curCommodity,
      cost,
      raw_row_text: trimmed,
    });
  }

  return {
    doc_id: stem,
    supplier,
    date,
    source_path: csvPath,
    format: "csv",
    duration_ms: Date.now() - t0,
    row_count: rows.length,
    rows,
  };
}

function main() {
  if (!existsSync(EXTRACTIONS_DIR)) mkdirSync(EXTRACTIONS_DIR, { recursive: true });
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: tsx scripts/parse_csv_supplierl.ts <csv-path> [...]");
    process.exit(2);
  }
  for (const arg of args) {
    const csvPath = resolve(arg);
    const doc = parseFile(csvPath);
    const outPath = join(EXTRACTIONS_DIR, `${doc.doc_id}.json`);
    writeFileSync(outPath, JSON.stringify(doc, null, 2));
    console.log(`✓ ${doc.doc_id} — ${doc.row_count} rows (${doc.duration_ms}ms)`);
    console.log(`  wrote ${outPath}`);
    console.log(`  first 3:`);
    for (const r of doc.rows.slice(0, 3)) console.log(`    ${JSON.stringify(r)}`);
  }
}

main();
