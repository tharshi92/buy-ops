/**
 * CLI: bake the BuyPlannerAgent's brief for one (or all) demo day(s).
 *
 * Usage:
 *   npx tsx scripts/run_buy_planner.ts                 # all days in demo_days.json
 *   npx tsx scripts/run_buy_planner.ts 2026-04-23      # one day
 *   npx tsx scripts/run_buy_planner.ts 2026-04-23 --limit 1   # debug single item
 *
 * Output: data/briefs/<delivery-date>.json (overwrites).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBuyPlanner, type ItemDecision } from "../lib/buy-planner.js";
import { listOpenOrders } from "../lib/agent-tools.js";
import { APP_ROOT, loadDemoDays } from "../lib/runs.js";

const BRIEFS_DIR = join(APP_ROOT, "data", "briefs");

function fmtItem(d: ItemDecision): string {
  const tag = d.decision === "pick" ? "✓ PICK" : "⊙ DEFER";
  const cost = typeof d.cost === "number" ? `$${d.cost.toFixed(2)}` : "-";
  const sup = d.supplier ?? "-";
  return `  ${tag.padEnd(8)} #${String(d.item.id).padStart(2)} ${d.item.name.padEnd(30).slice(0, 30)} → ${sup.padEnd(15)} ${cost.padEnd(8)} (${d.trace.duration_ms}ms, ${d.trace.tool_calls} tool calls)`;
}

async function bakeOne(day: string, limit?: number) {
  console.log(`\n══════ ${day} ══════`);
  if (limit) {
    const all = listOpenOrders(day);
    console.log(`(limit=${limit}, full day has ${all.length} orders)`);
  }

  const t0 = Date.now();
  const brief = await runBuyPlanner({
    delivery_date: day,
    concurrency: 4,
    limit,
    onItemDone: (d, idx, total) => {
      console.log(`[${(idx + 1).toString().padStart(2)}/${total}] ${fmtItem(d)}`);
    },
  });

  if (!existsSync(BRIEFS_DIR)) mkdirSync(BRIEFS_DIR, { recursive: true });
  const out = join(BRIEFS_DIR, `${day}.json`);
  writeFileSync(out, JSON.stringify(brief, null, 2));
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n→ wrote ${out}\n   ${brief.summary.picked}/${brief.summary.total_items} picked, ${brief.summary.deferred} deferred, est $${brief.summary.estimated_total_cost.toFixed(2)}, ${wall}s wall`,
  );
  return brief;
}

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "0", 10) : undefined;
  const dayArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

  const days = dayArg ? [dayArg] : Object.keys(loadDemoDays()).sort();
  for (const d of days) {
    await bakeOne(d, limit);
  }
}

main().catch((e) => {
  console.error("[run_buy_planner] threw:", e);
  process.exit(2);
});
