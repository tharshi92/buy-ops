# BuyOps — The Opus-Powered Automated Buy Team

> *Fresh produce doesn't wait. Neither should your buying operation.*

## The Problem

Jitto is a modern fresh produce wholesaler moving $2.5M of product per year across 100+ customers in the Greater Toronto Area. We are asset-light by design — almost no inventory, which means every single morning we go to the Ontario Food Terminal and buy exactly what our customers ordered.

That sounds simple. It is not.

**The daily buy loop looks like this:**

1. **Orders land** — 75% arrive the day before fulfillment. Everything must be purchased the morning of.
2. **Price extraction** — 20+ suppliers send price lists as PDFs and images. Reading, parsing, and entering these costs manually is a 40-hour-per-week job.
3. **Shopping list construction** — The evening before the buy, we cross-reference costs, supplier relationships, market conditions, and tribal knowledge to build an initial shopping list: supplier, SKU, quantity, expected cost, what we're charging customers, notes.
4. **Supplier negotiations** — We text suppliers to lock in deals and make adjustments before the morning run.
5. **The buy** — We go to the market. Product gets shorted. Quality isn't what we expected. Swaps happen. 5–10% of the list changes on the fly.
6. **Reconciliation** — We return with receipts. Actual costs differ from expected. Every variance must be found, corrected, and repriced — manually — before we can close the books. We cannot lose money on product. We cannot be uncompetitive.

That loop repeats every single day.

---

## The Solution

**BuyOps** replaces this loop with a team of Opus 4.7 agents, each owning a distinct role in the daily procurement cycle.

| Agent | Role |
|---|---|
| **Price Intelligence** | Ingests supplier price lists (PDF, image, scan) via vision, extracts and structures costs across all SKUs |
| **Order Analyst** | Reads customer orders, calculates net procurement requirements accounting for any on-hand inventory |
| **Shopping List Strategist** | Cross-references price intelligence, supplier history, and tribal knowledge to generate the optimal buy list with supplier assignments, quantities, and expected margins |
| **Negotiation Drafter** | Prepares supplier-specific negotiation messages grounded in market context and relationship history |
| **Reconciliation Agent** | Reads post-buy receipts, diffs actual vs expected costs, flags customer price adjustments, and closes the loop |

This is not a chatbot. This is an autonomous operations team that runs the daily procurement cycle end-to-end.

---

## Data

Built on real operational data from Jitto:

- ~1 year of supplier price lists from the Ontario Food Terminal (PDFs, images)
- Customer order data (CSV)
- Post-buy receipts capturing actuals, swaps, and shortages (PDFs, images)
- Tribal knowledge base: supplier profiles, negotiation history, quality notes

---

## Why This Matters

Fresh produce procurement is a daily, high-stakes, time-compressed operation that has never been touched by AI. Every small wholesaler, grocer, and distributor in the world runs this same manual loop. The inefficiency is enormous, the margin for error is costly, and the people doing it are burning out.

BuyOps is the proof that Opus 4.7 can run a real buying operation — not a demo, not a prototype, but the actual daily workflow of a real business.

---

## Built With

- Claude Opus 4.7 (multi-agent orchestration)
- Claude Managed Agents
- Anthropic SDK (Python)
