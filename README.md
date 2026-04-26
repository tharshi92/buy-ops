# BuyOps — Opus-Powered Daily Buy Brief

> *Fresh produce doesn't wait. Neither should your buying operation.*

A produce wholesaler buys 80–100 line items across 17+ suppliers every morning. The price lists are PDFs, the relationships live in iMessage, and the whole loop runs on tribal knowledge. BuyOps hands the morning to an Opus 4.7 agent team.

---

## The Problem

Jitto is a modern fresh produce wholesaler moving $2.5M of product per year across 100+ customers in the Greater Toronto Area. We're asset-light by design — almost no inventory — which means every single morning we go to the Ontario Food Terminal and buy exactly what our customers ordered.

That sounds simple. It is not. Every day:

1. **Orders land** — 75% arrive the day before fulfillment. Everything must be purchased the morning of.
2. **Price extraction** — 20+ suppliers send price lists as PDFs and images. Reading, parsing, and entering these costs manually is a 40-hour-per-week job.
3. **Shopping list construction** — Cross-reference costs, supplier relationships, market conditions, and tribal knowledge to build the buy list: supplier, SKU, quantity, expected cost, notes.
4. **Supplier negotiations** — Text suppliers to lock in deals and surface issues before the morning run.
5. **The buy** — 5–10% of the list changes on the fly: shorts, quality, swaps.
6. **Reconciliation** — Diff actual vs. expected costs, reprice anything affected, close the books before the next cycle starts.

That loop repeats every single day.

---

## What BuyOps Unlocks

| Unlock | What it means |
|---|---|
| **Reads every price list** | 20+ suppliers, every PDF/scan/txt/CSV. Opus 4.7 vision turns the daily 40-hour parsing job into seconds, normalized into one commodity index. |
| **Remembers every conversation** | The agent re-reads the last 14 days of iMessages with each supplier. It won't pick from a lot you just rejected, a price that's quietly drifted, or a SKU that was shorted yesterday. |
| **Decides per item, in parallel** | One Claude session per order line, fanned out via a custom MCP toolset. 80 buying decisions in ~10 min of agent time at concurrency 4. |
| **Drafts the messages, ready to send** | Picks grouped by supplier and rendered as iMessage-ready text — name, qty, pack, locked-in price, plus any open questions. Click copy, paste, hit send. |

---

## Architecture

```
┌──────────────────────┐    ┌────────────────────────┐
│ Supplier price lists │───►│ Phase 1: vision extract │──┐
│ (24 PDFs/CSVs/TXTs)  │    │ (Opus 4.7, per page)    │  │
└──────────────────────┘    └────────────────────────┘  │
                                                         ▼
┌──────────────────────┐                       ┌─────────────────────┐
│ Supplier iMessages   │──────────────────────►│ coarse_offerings.json│
│ (anonymized .txt)    │                       │ (commodity → rows)   │
└──────────────────────┘                       └─────────────────────┘
                                                         │
┌──────────────────────┐                                 │
│ Daily orders         │────┐                            │
│ (CSV per delivery)   │    │                            │
└──────────────────────┘    │                            │
                            ▼                            ▼
                  ┌────────────────────────────────────────────┐
                  │ Phase 2: BuyPlannerAgent                    │
                  │   pool(orders, concurrency=4)               │
                  │     └─ query() per item with custom MCP:    │
                  │         find_commodity                      │
                  │         get_offerings(asof=delivery_date)   │
                  │         get_supplier_chats(tail_days=14)    │
                  │         get_price_history                   │
                  └────────────────────────────────────────────┘
                                        │
                                        ▼
                  ┌────────────────────────────────────────────┐
                  │ Brief: picks · deferred · supplier drafts   │
                  │   (data/briefs/<delivery-date>.json)        │
                  └────────────────────────────────────────────┘
                                        │
                                        ▼
                  ┌────────────────────────────────────────────┐
                  │ Phase 3+5: Next.js dashboard                │
                  │   Replay decisions ▶ (animated)             │
                  │   Load instantly · Run live (real SDK call) │
                  └────────────────────────────────────────────┘
```

The fan-out happens in JS rather than as one big agent loop because:

- Decisions are independent — parallelism is free.
- Failures isolate: one bad item doesn't poison the brief.
- Token budget per item stays small + predictable.
- Streams cleanly into a per-item activity panel in the UI.

---

## Demo

```bash
cd hackathon-app
npm install
npm run dev
# open http://localhost:3000 — day 2026-04-23 auto-loads
```

Once loaded:

- **▶ Replay decisions** — animates the pre-baked brief into the activity panel over ~22s, then reveals the full picks/deferred/supplier drafts.
- **Load instantly** — skip the animation, brief immediately.
- **Run live (4)** — actually invokes the BuyPlannerAgent on the first 4 order lines via the SDK. Slower (~few minutes on dev) but it's real Claude calls happening right now.

To re-bake the briefs from the CLI:

```bash
npx tsx scripts/run_buy_planner.ts                 # all demo days
npx tsx scripts/run_buy_planner.ts 2026-04-23      # one day
npx tsx scripts/run_buy_planner.ts 2026-04-23 --limit 4
```

To re-extract the supplier price lists from the source PDFs:

```bash
npx tsx scripts/extract_all.ts
```

---

## What the agent caught (real examples)

These are real defers and picks from the baked briefs, all driven by the agent reading recent supplier chats:

- **Lettuce Iceberg** — agent deferred grade-#2 iceberg from supplier X because the Apr 14 chats showed Jitto had rejected that exact lot two weeks earlier.
- **Parsley Flat** — supplier confirmed a price hike in chat ($38 → $54). On day 1 the agent deferred (price not yet in the price list); on day 2 it picked at the confirmed $54.
- **Lime 230s** — supplier had messaged about a short on this SKU. Agent surfaced the question rather than blind-picking.
- **Avocado Bagged 6 Pack** — supplier said "no bagged avocados this week" in chat. Agent deferred and asked.
- **Zucchini Yellow / Apple Granny Smith** — variety/pack-size mismatches in offerings. Agent caught both, deferred with a clarifying question.

---

## Data

Built on real operational data from Jitto, anonymized in `anonymizer/`:

- 24 supplier price lists (PDFs, CSVs, TXTs) covering the week of 2026-04-17 → 2026-04-24
- 17 supplier iMessage chat logs spanning 5–6 weeks of operations
- 2 days of customer orders (`2026-04-23`: 80 lines, `2026-04-24`: 95 lines)

Suppliers are de-identified as `supplier-a` … `supplier-s`. Customer names are stripped from chat logs.

---

## Built With

- **Claude Opus 4.7** — vision extraction (Phase 1) + per-item buy decisions (Phase 2)
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — `query()` + custom MCP server via `createSdkMcpServer()`
- **Next.js 16** + React 19 + Tailwind 4 — dashboard with SSE streaming and animated replay
- **Anthropic SDK** (Node) — direct API for vision extraction
