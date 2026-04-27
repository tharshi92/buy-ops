/**
 * BuyPlannerAgent — fan out one Claude session per order line, each with the
 * same MCP toolset (find_commodity, get_offerings, get_supplier_chats,
 * get_price_history). Each session returns a single structured decision
 * (pick or defer). The orchestrator (this file) groups picks by supplier and
 * renders one consolidated draft message per supplier with the deterministic
 * draft_supplier_message template.
 *
 * Why fan out at the JS layer instead of one big agent loop:
 *   - Decisions are independent — parallelism is free.
 *   - Failures isolate: one bad item ≠ poisoned brief.
 *   - Token budget per item stays small + predictable.
 *   - Easy to render a per-item "agent activity" stream in the UI later.
 */

import { z } from "zod";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  listOpenOrders,
  findCommodity,
  getOfferings,
  getSupplierChats,
  getPriceHistory,
  draftSupplierMessage,
} from "./agent-tools";
import type { OrderLine } from "./runs";

// ---------- Brief schema -----------------------------------------------------

export type ItemDecision = {
  item: OrderLine;
  decision: "pick" | "defer";
  commodity?: string;
  supplier?: string;
  cost?: number | null;
  raw_row_text?: string;
  rationale: string;
  supplier_question?: string;
  trace: {
    tool_calls: number;
    duration_ms: number;
    error?: string;
  };
};

export type SupplierDraft = {
  supplier: string;
  picks: Array<{ item_id: number; description: string; qty: number; pkg: string; cost: number | null }>;
  questions: Array<{ item_id: number; question: string }>;
  message: string;
};

export type Brief = {
  delivery_date: string;
  generated_at: string;
  picks: ItemDecision[];
  deferred: ItemDecision[];
  drafts: SupplierDraft[];
  summary: {
    total_items: number;
    picked: number;
    deferred: number;
    estimated_total_cost: number;
    total_duration_ms: number;
  };
};

// ---------- MCP tool wrappers ------------------------------------------------

function makeBuyOpsServer(deliveryDate: string) {
  return createSdkMcpServer({
    name: "buyops",
    version: "0.1.0",
    tools: [
      tool(
        "find_commodity",
        "Find which commodity bucket(s) a free-text item description belongs to. Returns up to 5 ranked candidates with row counts and sample variant text. ALWAYS call this first to translate the order's name into the commodity key the other tools accept.",
        { query: z.string().describe("Free-text item name like 'Banana Turning' or 'Onion Spanish Jumbo'") },
        async ({ query: q }) => {
          const out = findCommodity(q);
          return {
            content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          };
        },
      ),
      tool(
        "get_offerings",
        `Return every supplier currently offering a commodity, with their latest effective price as of the delivery date (${deliveryDate}). Sorted cheapest-priced first; null-priced (PTF) rows last. Use this after find_commodity to see the buy options.`,
        { commodity: z.string().describe("Commodity key in CAPS, e.g. 'BANANAS' (must come from find_commodity output)") },
        async ({ commodity }) => {
          const out = getOfferings(commodity, deliveryDate);
          return {
            content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          };
        },
      ),
      tool(
        "get_supplier_chats",
        `Return the recent (default 14 days back from ${deliveryDate}) iMessage chat history with a supplier. Use this to check for recent shorts, quality complaints, or special pricing notes that should influence the buy decision.`,
        {
          supplier: z.string().describe("Supplier id, e.g. 'supplier-a'"),
          tail_days: z.number().int().positive().max(60).optional().describe("How many days back to include. Default 14."),
        },
        async ({ supplier, tail_days }) => {
          const out = getSupplierChats(supplier, deliveryDate, tail_days ?? 14);
          return { content: [{ type: "text", text: out.slice(0, 12000) }] };
        },
      ),
      tool(
        "get_price_history",
        "Return the price timeline for a commodity, optionally filtered to one supplier. Use this when you want to see whether a price is trending up or down before recommending it.",
        {
          commodity: z.string(),
          supplier: z.string().optional(),
        },
        async ({ commodity, supplier }) => {
          const out = getPriceHistory(commodity, supplier);
          return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
        },
      ),
    ],
  });
}

// ---------- Per-item agent ---------------------------------------------------

const PER_ITEM_PROMPT = (item: OrderLine, deliveryDate: string) => `
You are buying produce for delivery on ${deliveryDate}. ONE order line is on
your desk:

  id: ${item.id}
  name: "${item.name}"
  description (pack size): "${item.description}"
  quantity to buy: ${item.quantity}
  number of customer orders rolled in: ${item.n_orders}

Your job: decide where to buy it from, OR mark it deferred if you can't.

Workflow:
 1. Call mcp__buyops__find_commodity with the item name to find the right
    commodity bucket. Pick the top candidate unless it's clearly wrong.
 2. Call mcp__buyops__get_offerings on that commodity to see today's options.
 3. If there are multiple priced options close in price, OR if the cheapest
    looks unusual (much lower/higher than peers), call
    mcp__buyops__get_supplier_chats on the candidate supplier(s) to check for
    recent issues (shorts, quality complaints, swap-outs).
 4. Optionally call mcp__buyops__get_price_history to see the trend.
 5. Make a decision.

Decision rules:
 - "pick": you found a clear buy. Pick the supplier with best $/quality
   tradeoff (cheapest unless chats reveal a problem).
 - "defer": no priced offerings (all PTF/null), no offerings at all, OR chats
   reveal an active problem (recent short, quality complaint not resolved). In
   defer mode, write a short question we should send the supplier(s).

Respond with EXACTLY one JSON object, no prose, no markdown:

{
  "decision": "pick" | "defer",
  "commodity": "<COMMODITY in caps from find_commodity>",
  "supplier": "<supplier-x or null if defer>",
  "cost": <number or null>,
  "raw_row_text": "<the matching offering row's raw_row_text or null>",
  "rationale": "<one sentence on why this choice>",
  "supplier_question": "<short question to send if defer, else null>"
}

The first character of your response MUST be { and the last MUST be }.
`.trim();

const PerItemSchema = z.object({
  decision: z.enum(["pick", "defer"]),
  commodity: z.string().nullable().optional(),
  supplier: z.string().nullable().optional(),
  cost: z.number().nullable().optional(),
  raw_row_text: z.string().nullable().optional(),
  rationale: z.string(),
  supplier_question: z.string().nullable().optional(),
});

function tryParseObject(text: string): unknown | null {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1]!.trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function decideOneItem(item: OrderLine, deliveryDate: string): Promise<ItemDecision> {
  const t0 = Date.now();
  let tool_calls = 0;
  let lastText = "";
  let success = false;

  try {
    const q = query({
      prompt: PER_ITEM_PROMPT(item, deliveryDate),
      options: {
        model: "claude-opus-4-7",
        maxTurns: 10,
        permissionMode: "bypassPermissions",
        mcpServers: { buyops: makeBuyOpsServer(deliveryDate) },
        allowedTools: [
          "mcp__buyops__find_commodity",
          "mcp__buyops__get_offerings",
          "mcp__buyops__get_supplier_chats",
          "mcp__buyops__get_price_history",
        ],
      },
    });
    for await (const msg of q) {
      if (msg.type === "assistant") {
        let txt = "";
        for (const block of msg.message.content) {
          if (block.type === "text") txt += block.text;
          if (block.type === "tool_use") tool_calls++;
        }
        // accumulate rather than overwrite — final assistant turn is sometimes
        // a confirmation ("Done.") after the JSON-bearing turn, which would
        // otherwise clobber the parseable output
        if (txt.trim().length > 0) lastText += (lastText ? "\n" : "") + txt;
      }
      if (msg.type === "result") {
        success = msg.subtype === "success";
        break;
      }
    }
  } catch (e) {
    return {
      item,
      decision: "defer",
      rationale: `agent error: ${(e as Error).message}`,
      trace: { tool_calls, duration_ms: Date.now() - t0, error: (e as Error).message },
    };
  }

  if (!success) {
    return {
      item,
      decision: "defer",
      rationale: "agent did not return success",
      trace: { tool_calls, duration_ms: Date.now() - t0, error: `last text: ${lastText.slice(0, 200)}` },
    };
  }

  const raw = tryParseObject(lastText);
  const parsed = PerItemSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      item,
      decision: "defer",
      rationale: "agent returned unparseable output",
      trace: { tool_calls, duration_ms: Date.now() - t0, error: parsed.error.message.slice(0, 200) },
    };
  }
  const d = parsed.data;
  return {
    item,
    decision: d.decision,
    commodity: d.commodity ?? undefined,
    supplier: d.supplier ?? undefined,
    cost: d.cost ?? undefined,
    raw_row_text: d.raw_row_text ?? undefined,
    rationale: d.rationale,
    supplier_question: d.supplier_question ?? undefined,
    trace: { tool_calls, duration_ms: Date.now() - t0 },
  };
}

// ---------- Concurrency-bounded fan-out -------------------------------------

async function pool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------- Orchestrator -----------------------------------------------------

function buildSupplierDrafts(
  deliveryDate: string,
  decisions: ItemDecision[],
): SupplierDraft[] {
  const grouped = new Map<string, SupplierDraft>();

  for (const d of decisions) {
    if (d.decision === "pick" && d.supplier) {
      const g = grouped.get(d.supplier) ?? {
        supplier: d.supplier,
        picks: [],
        questions: [],
        message: "",
      };
      g.picks.push({
        item_id: d.item.id,
        description: d.item.name,
        qty: d.item.quantity,
        pkg: d.item.description,
        cost: d.cost ?? null,
      });
      grouped.set(d.supplier, g);
    }
  }

  // questions: deferred items don't always name a supplier — bucket those
  // under "(open)" so the human sees what to chase
  for (const d of decisions) {
    if (d.decision === "defer" && d.supplier_question) {
      const key = d.supplier ?? "(open)";
      const g = grouped.get(key) ?? {
        supplier: key,
        picks: [],
        questions: [],
        message: "",
      };
      g.questions.push({ item_id: d.item.id, question: d.supplier_question });
      grouped.set(key, g);
    }
  }

  for (const g of grouped.values()) {
    if (g.supplier === "(open)") {
      g.message = g.questions.map((q) => `[item #${q.item_id}] ${q.question}`).join("\n");
    } else {
      g.message = draftSupplierMessage({
        supplier: g.supplier,
        delivery_date: deliveryDate,
        items: g.picks.map((p) => ({
          qty: p.qty,
          pkg: p.pkg,
          description: p.description,
          cost: p.cost,
        })),
        note: g.questions.length
          ? "Also — " + g.questions.map((q) => q.question).join(" ")
          : undefined,
      });
    }
  }

  return [...grouped.values()].sort((a, b) => a.supplier.localeCompare(b.supplier));
}

export async function runBuyPlanner(opts: {
  delivery_date: string;
  concurrency?: number;
  limit?: number;
  onItemDone?: (d: ItemDecision, idx: number, total: number) => void;
}): Promise<Brief> {
  const t0 = Date.now();
  const allOrders = listOpenOrders(opts.delivery_date);
  const orders = opts.limit ? allOrders.slice(0, opts.limit) : allOrders;
  const concurrency = opts.concurrency ?? 4;

  const decisions = await pool(orders, concurrency, async (item, idx) => {
    const d = await decideOneItem(item, opts.delivery_date);
    opts.onItemDone?.(d, idx, orders.length);
    return d;
  });

  const picks = decisions.filter((d) => d.decision === "pick");
  const deferred = decisions.filter((d) => d.decision === "defer");
  const drafts = buildSupplierDrafts(opts.delivery_date, decisions);

  const estimated_total_cost = picks.reduce(
    (sum, p) => sum + (typeof p.cost === "number" ? p.cost * p.item.quantity : 0),
    0,
  );

  return {
    delivery_date: opts.delivery_date,
    generated_at: new Date().toISOString(),
    picks,
    deferred,
    drafts,
    summary: {
      total_items: allOrders.length,
      picked: picks.length,
      deferred: deferred.length,
      estimated_total_cost,
      total_duration_ms: Date.now() - t0,
    },
  };
}
