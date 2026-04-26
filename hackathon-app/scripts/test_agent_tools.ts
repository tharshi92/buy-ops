/**
 * Smoke tests for lib/agent-tools.ts. Not a proper unit suite — just exercises
 * each function against the baked corpus and dumps a summary so we can eyeball
 * the shape before wiring them into the agent.
 */

import {
  listOpenOrders,
  findCommodity,
  getOfferings,
  getSupplierChats,
  getPriceHistory,
  draftSupplierMessage,
} from "../lib/agent-tools.js";

function header(s: string) {
  console.log("\n" + "═".repeat(70) + "\n  " + s + "\n" + "═".repeat(70));
}

function main() {
  header("1. listOpenOrders('2026-04-23')");
  const orders = listOpenOrders("2026-04-23");
  console.log(`got ${orders.length} lines, first 3:`);
  console.log(JSON.stringify(orders.slice(0, 3), null, 2));

  header("2. findCommodity('Banana Turning')");
  console.log(JSON.stringify(findCommodity("Banana Turning"), null, 2));

  header("2b. findCommodity('Brussels Sprouts')");
  console.log(JSON.stringify(findCommodity("Brussels Sprouts"), null, 2));

  header("2c. findCommodity('Onion Spanish Jumbo')");
  console.log(JSON.stringify(findCommodity("Onion Spanish Jumbo"), null, 2));

  header("3. getOfferings('BANANAS', '2026-04-23')");
  const off = getOfferings("BANANAS", "2026-04-23");
  console.log(`${off.length} suppliers offering BANANAS as of 2026-04-23:`);
  console.log(JSON.stringify(off.slice(0, 8), null, 2));

  header("4. getSupplierChats('supplier-a', '2026-04-23', 7)");
  const chats = getSupplierChats("supplier-a", "2026-04-23", 7);
  console.log(`${chats.split("\n").length} lines, first 800 chars:`);
  console.log(chats.slice(0, 800));

  header("5. getPriceHistory('BANANAS', 'supplier-a')");
  console.log(JSON.stringify(getPriceHistory("BANANAS", "supplier-a"), null, 2));

  header("6. draftSupplierMessage");
  console.log(
    draftSupplierMessage({
      supplier: "supplier-a",
      delivery_date: "2026-04-23",
      items: [
        { qty: 2, pkg: "40 lb", description: "Banana Turning #1 Dole", cost: 32 },
        { qty: 1, pkg: "10 lb", description: "Mushroom Brown Caps Local", cost: 16 },
      ],
      note: "Heads up: customer flagged that last week's bananas were too green.",
    }),
  );
}

main();
