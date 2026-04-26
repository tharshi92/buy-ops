/**
 * Pure-function data accessors that back the BuyPlannerAgent's tools.
 *
 * Kept free of SDK imports so they are unit-testable and reusable from API
 * routes. The MCP wrapper in lib/buy-planner.ts adapts these into tool calls.
 *
 * All five functions read from already-baked artifacts only:
 *   - coarse_offerings.json  (commodity → list of supplier rows w/ effective dates)
 *   - supplier_chat_logs/    (one cumulative .txt per supplier, date-filtered)
 *   - orders/<date>.csv      (one delivery day at a time)
 *
 * Nothing here calls the network.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CORPUS_CHAT_LOGS,
  CORPUS_ORDERS,
  PRE_BAKED_INDEX,
  type OrderLine,
} from "./runs";

export type OfferingRow = {
  doc_id: string;
  supplier: string;
  effective_start: string;
  effective_end: string | null;
  row_idx: number;
  commodity: string;
  cost: number | null;
  raw_row_text: string;
};

type CoarseOfferings = Record<string, OfferingRow[]>;

let _index: CoarseOfferings | null = null;

function loadIndex(): CoarseOfferings {
  if (_index) return _index;
  if (!existsSync(PRE_BAKED_INDEX)) {
    throw new Error(`coarse_offerings.json missing at ${PRE_BAKED_INDEX}`);
  }
  _index = JSON.parse(readFileSync(PRE_BAKED_INDEX, "utf-8")) as CoarseOfferings;
  return _index;
}

// --- 1. list_open_orders ---------------------------------------------------

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

export function listOpenOrders(deliveryDate: string): OrderLine[] {
  const path = join(CORPUS_ORDERS, `${deliveryDate}.csv`);
  if (!existsSync(path)) {
    throw new Error(`no orders file for ${deliveryDate} at ${path}`);
  }
  return parseOrdersCsv(readFileSync(path, "utf-8"));
}

// --- 2. find_commodity -----------------------------------------------------

export type CommodityCandidate = {
  commodity: string;
  row_count: number;
  sample_variants: string[];
  score: number;
};

function stem(t: string): string {
  if (t.length > 3 && t.endsWith("s")) return t.slice(0, -1);
  return t;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .map(stem);
}

const STOPWORDS = new Set([
  "the", "and", "with", "for", "from", "lb", "lbs", "ct", "ea", "case",
  "pcs", "pieces", "bag", "box", "bunch", "each",
]);

/**
 * Fuzzy-find candidate commodities for a free-text item description.
 *
 * Strategy: tokenize the query, score each commodity by overlap of its name
 * tokens + sampled variant tokens. Returns up to topK candidates so the agent
 * can pick — keeps it agentic (vs. forcing one answer) while pruning the
 * 260-commodity space hard.
 */
export function findCommodity(query: string, topK = 5): CommodityCandidate[] {
  const idx = loadIndex();
  const qTokens = new Set(tokenize(query).filter((t) => !STOPWORDS.has(t)));
  if (qTokens.size === 0) return [];

  const scored: CommodityCandidate[] = [];
  for (const [commodity, rows] of Object.entries(idx)) {
    const nameTokens = new Set(tokenize(commodity));
    let score = 0;
    for (const t of qTokens) {
      if (nameTokens.has(t)) score += 5;
    }
    // sample first ~10 rows for variant overlap (cheap)
    const sample = rows.slice(0, 10);
    const variantTokens = new Set<string>();
    for (const r of sample) {
      for (const t of tokenize(r.raw_row_text)) {
        if (!STOPWORDS.has(t)) variantTokens.add(t);
      }
    }
    for (const t of qTokens) {
      if (variantTokens.has(t)) score += 1;
    }
    if (score === 0) continue;
    scored.push({
      commodity,
      row_count: rows.length,
      sample_variants: sample.slice(0, 3).map((r) => r.raw_row_text),
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score || b.row_count - a.row_count);
  return scored.slice(0, topK);
}

// --- 3. get_offerings ------------------------------------------------------

export type SupplierOffering = {
  supplier: string;
  doc_id: string;
  effective_start: string;
  cost: number | null;
  raw_row_text: string;
};

/**
 * For a commodity, return the best (latest effective) row per supplier as of
 * `asof`. Drops rows with effective_start > asof (future price lists). If two
 * rows for the same supplier are both effective, prefers the later
 * effective_start.
 */
export function getOfferings(commodity: string, asof: string): SupplierOffering[] {
  const idx = loadIndex();
  const rows = idx[commodity];
  if (!rows) return [];

  const eligible = rows.filter((r) => {
    if (r.effective_start > asof) return false;
    if (r.effective_end && r.effective_end < asof) return false;
    return true;
  });

  // pick latest per supplier
  const bySupplier = new Map<string, OfferingRow>();
  for (const r of eligible) {
    const cur = bySupplier.get(r.supplier);
    if (!cur || r.effective_start > cur.effective_start) {
      bySupplier.set(r.supplier, r);
    }
  }

  return [...bySupplier.values()]
    .map((r) => ({
      supplier: r.supplier,
      doc_id: r.doc_id,
      effective_start: r.effective_start,
      cost: r.cost,
      raw_row_text: r.raw_row_text,
    }))
    .sort((a, b) => {
      // priced rows first, cheapest first
      if (a.cost == null && b.cost == null) return a.supplier.localeCompare(b.supplier);
      if (a.cost == null) return 1;
      if (b.cost == null) return -1;
      return a.cost - b.cost;
    });
}

// --- 4. get_supplier_chats -------------------------------------------------

function findChatLogFile(supplier: string): string | null {
  if (!existsSync(CORPUS_CHAT_LOGS)) return null;
  const prefix = `${supplier}_`;
  for (const f of readdirSync(CORPUS_CHAT_LOGS)) {
    if (f.startsWith(prefix) && f.endsWith(".txt")) {
      return join(CORPUS_CHAT_LOGS, f);
    }
  }
  return null;
}

/**
 * Returns the last `tailDays` of chat history for a supplier, filtered to
 * messages on/before `asof`. Block-aware (a message header `[YYYY-MM-DD,`
 * starts a block, continuation lines belong to it).
 *
 * Default 14 days keeps the agent's context budget sane while preserving
 * recent shorts/quality complaints/relationship signal.
 */
export function getSupplierChats(
  supplier: string,
  asof: string,
  tailDays = 14,
): string {
  const path = findChatLogFile(supplier);
  if (!path) return `(no chat log on file for ${supplier})`;

  const cutoff = (() => {
    const d = new Date(asof + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - tailDays);
    return d.toISOString().slice(0, 10);
  })();

  const headerRe = /^\[(\d{4}-\d{2}-\d{2}),/;
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  const out: string[] = [];
  let keep = false;
  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) {
      const date = m[1]!;
      keep = date >= cutoff && date <= asof;
    }
    if (keep) out.push(line);
  }
  return out.length ? out.join("\n") : `(no messages between ${cutoff} and ${asof})`;
}

// --- 5. get_price_history --------------------------------------------------

export type PricePoint = {
  date: string;
  supplier: string;
  cost: number | null;
  raw_row_text: string;
};

/**
 * Time-series of every priced row for a commodity, optionally filtered to one
 * supplier. Sorted by effective_start ascending. Includes nulls so the agent
 * can see PTF gaps.
 */
export function getPriceHistory(
  commodity: string,
  supplier?: string,
): PricePoint[] {
  const idx = loadIndex();
  const rows = idx[commodity];
  if (!rows) return [];
  const filtered = supplier ? rows.filter((r) => r.supplier === supplier) : rows;
  return filtered
    .map((r) => ({
      date: r.effective_start,
      supplier: r.supplier,
      cost: r.cost,
      raw_row_text: r.raw_row_text,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.supplier.localeCompare(b.supplier));
}

// --- 6. draft_supplier_message ---------------------------------------------

export type DraftMessageInput = {
  supplier: string;
  delivery_date: string;
  items: Array<{ qty: number; pkg: string; description: string; cost?: number | null }>;
  note?: string;
};

/**
 * Pure template. The agent assembles the items list (after deciding what to
 * order from this supplier) and we render the iMessage-ready draft. No LLM
 * here — the agent's job is to *choose*, not to wordsmith.
 */
export function draftSupplierMessage(input: DraftMessageInput): string {
  const { supplier, delivery_date, items, note } = input;
  const lines: string[] = [];
  const dayLabel = new Date(delivery_date + "T00:00:00").toLocaleDateString(
    "en-US",
    { month: "long", day: "numeric" },
  );
  lines.push(`Hi ${supplier.replace(/^supplier-/, "Supplier ").toUpperCase()} —`);
  lines.push(`Order for ${dayLabel} delivery:`);
  lines.push("");
  for (const it of items) {
    const priceTail = typeof it.cost === "number" ? ` @ $${it.cost.toFixed(2)}` : "";
    lines.push(`• ${it.qty} × ${it.description} (${it.pkg})${priceTail}`);
  }
  lines.push("");
  if (note && note.trim().length > 0) lines.push(note.trim());
  lines.push("Please confirm availability and final pricing. Thanks!");
  return lines.join("\n");
}
