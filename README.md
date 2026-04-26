# BuyOps — Daily Buy Brief by Opus 4.7

> *Fresh produce doesn't wait. Neither should your buying operation.*

I work at a produce wholesaler. Every morning my team buys around 80 different items from 17 suppliers at the Ontario Food Terminal. The price lists come in as PDFs and scans. The relationships with each supplier live in iMessage. A lot of the job is just remembering things.

BuyOps takes that morning and gives it to a team of Opus 4.7 agents.

---

## The Problem

Jitto is a produce wholesaler in Toronto. We move about $2.5M of product a year to 100+ customers. We carry almost no inventory, which means every morning we go to the food terminal and buy exactly what our customers ordered the day before.

That sounds simple. It is not. Every day:

1. **Orders land.** Most arrive the night before. They all need to be bought the next morning.
2. **Price lists come in.** From 20+ suppliers, in every format you can think of: PDFs, scans, csvs, plain text. Reading and entering them by hand is a 40-hour-per-week job.
3. **The buy list gets built.** You match each item to a supplier, decide the quantity, and lock in a price. You're juggling cost, what your customer is paying, the supplier you're on good terms with, and what they shorted you on yesterday.
4. **You text the suppliers.** To confirm pricing, lock in lots, and surface anything that might be a problem.
5. **You go to the market.** Then 5–10% of the list changes on the fly. Quality is off, something is sold out, a swap happens.
6. **You reconcile.** Compare what you actually paid to what you expected. Reprice anything that drifted. Close the books before the next morning starts.

That whole loop runs every single day.

---

## What BuyOps Unlocks

| Unlock | What it means |
|---|---|
| **Reads every price list** | 20+ suppliers, every PDF, scan, txt, and csv. Opus 4.7 reads them all and turns them into one clean index of who is selling what for how much. |
| **Remembers every conversation** | The agent re-reads the last two weeks of texts with each supplier. It won't pick from a lot you already rejected, a price that quietly went up, or a SKU that was shorted yesterday. |
| **Decides each item, in parallel** | For every line on today's order, a separate Claude session runs. It picks a supplier, locks in a price, or stops and asks a question if something is off. |
| **Drafts the messages, ready to send** | The picks get grouped by supplier and turned into the actual iMessage you would send. Click copy, paste, hit send. |

---

## How It Works

Three steps:

**1. Read every price list.** Opus 4.7 reads each supplier document (PDF, csv, txt) and pulls out one row per item: commodity name, price, date the price is good for, the original line of text. All of this gets folded into one big index.

**2. Decide each item.** For every line on today's order, a separate Claude session runs. It has four tools:

- `find_commodity` — match the order item to the right bucket in the index
- `get_offerings` — see which suppliers are selling that commodity right now, sorted by price
- `get_supplier_chats` — read the last two weeks of texts with a supplier
- `get_price_history` — see how the price has moved over time

The session picks a supplier and a price, or stops and writes a question if something looks off.

**3. Write the messages.** The picks get grouped by supplier. A simple template turns each group into the actual iMessage you would send. No agent involved here, just a string template.

The dashboard ties it together. You can replay a saved brief like a movie, load it instantly, or run a few items live to watch the agents work.

### Why fan out instead of one big agent?

Each item is independent, so they can run at the same time. If one crashes, the rest of the brief still ships. The token budget per item stays small. And it looks great streaming into the activity panel.

---

## Demo

```bash
cd hackathon-app
npm install
npm run dev
# open http://localhost:3000 — day 2026-04-23 auto-loads
```

Three buttons on the dashboard:

- **▶ Replay decisions** — animates the saved brief into the activity panel over about 22 seconds, then shows the full picks, deferred items, and supplier drafts.
- **Load instantly** — skip the animation, see the brief right away.
- **Run live (4)** — actually run the agents on the first 4 order lines. Real Claude calls. Slow on dev (~few minutes) but it's the agents working in real time.

To re-bake the briefs from the command line:

```bash
npx tsx scripts/run_buy_planner.ts                 # both demo days
npx tsx scripts/run_buy_planner.ts 2026-04-23      # one day
npx tsx scripts/run_buy_planner.ts 2026-04-23 --limit 4
```

To re-extract supplier price lists from the PDFs:

```bash
npx tsx scripts/extract_all.ts
```

---

## What the Agent Caught

These are real picks and defers from the saved briefs. All of them came from the agent reading recent supplier chats:

- **Lettuce Iceberg** — agent deferred a grade-#2 iceberg from one supplier because the chat from two weeks earlier showed Jitto had rejected that exact lot.
- **Parsley Flat** — supplier confirmed a price hike in chat ($38 → $54). Day 1 the agent deferred (the price list hadn't caught up). Day 2 the agent picked at the confirmed $54.
- **Lime 230s** — supplier had texted about a short on this size. The agent flagged it as a question instead of blindly picking.
- **Avocado Bagged 6 Pack** — supplier said "no bagged avocados this week" in chat. The agent deferred and asked.
- **Zucchini Yellow / Apple Granny Smith** — variety and pack-size mismatches in offerings. The agent caught both and asked for clarification.

---

## Data

Real operational data from Jitto, anonymized in `anonymizer/`:

- **27 supplier price lists** (PDFs, csvs, txts) covering 2026-04-17 through 2026-04-24
- **17 supplier iMessage chat logs.** Most cover the last 5–6 weeks; one supplier goes back a full year
- **2 demo days of customer orders.** 2026-04-23 has 80 line items, 2026-04-24 has 95

Suppliers are named `supplier-a` through `supplier-s`. Customer names are stripped from the chat logs.

---

## Built With

- **Claude Opus 4.7** — vision pass over price lists, and the per-item buying decisions
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — drives the per-item agent with a custom in-process MCP server
- **Anthropic SDK** (`@anthropic-ai/sdk`) — the direct API used for the vision pass
- **Next.js 16, React 19, Tailwind 4** — the dashboard, including the streaming live run and the animated replay
