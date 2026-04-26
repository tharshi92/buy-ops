/**
 * Phase 0 — Check 1b: vision over a real PDF via Agent SDK + Claude Code
 * linkage. Reads one supplier price list and extracts coarse rows in the
 * locked schema {commodity, cost, raw_row_text}.
 *
 * Run: npx tsx scripts/test_vision.ts [path/to/file.pdf]
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_PDF =
  "/Users/tharshi/GitHub/builtwithopus47/buy-ops/data/price_lists/supplier-n-2026-04-24.pdf";

const PROMPT = (pdfPath: string) => `
Use the Read tool to read the PDF at ${pdfPath}. It is a wholesale produce
supplier price list.

Extract every product offering row. For each row return one JSON object with:
  - "commodity": broad category in CAPS, taken from the row's section header or
    the row's lead word. Examples: "BANANAS", "GRAPES", "LEMONS", "CHERRIES",
    "ROMAINE LETTUCE". Pick the closest distinct commodity word.
  - "cost": numeric USD/CAD price as a number (no $ sign). For ranges or tiers,
    use the LOWEST. For PTF, TOS, blank, or no price → use null.
  - "raw_row_text": the verbatim text of the row, including ALL tokens
    (variety, packsize, brand, grade, origin, status). One line.

Return ONLY a JSON array of objects, nothing else. No prose, no commentary, no
markdown code fences. The first character must be \`[\` and the last must be
\`]\`. Example shape:
[
  {"commodity": "BANANAS", "cost": 32.00, "raw_row_text": "BANANA #1 DOLE 32.00"},
  {"commodity": "GRAPES", "cost": null, "raw_row_text": "GRAPE THOMPSON SDLS PTF"}
]
`.trim();

function tryParseJson(text: string): unknown[] | null {
  // Strip markdown fences if model wraps anyway
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1]!.trim();
  try {
    const parsed = JSON.parse(t);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    // Try to extract the first [...] block
    const start = t.indexOf("[");
    const end = t.lastIndexOf("]");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(t.slice(start, end + 1));
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function main() {
  const pdfPath = resolve(process.argv[2] ?? DEFAULT_PDF);
  if (!existsSync(pdfPath)) {
    console.error(`PDF not found: ${pdfPath}`);
    process.exit(2);
  }
  const sizeKb = Math.round(readFileSync(pdfPath).byteLength / 1024);
  console.log(`[vision] PDF: ${pdfPath} (${sizeKb} KB)`);

  const t0 = Date.now();
  let lastAssistantText = "";
  let toolUses = 0;

  const q = query({
    prompt: PROMPT(pdfPath),
    options: {
      model: "claude-opus-4-7",
      maxTurns: 5,
      allowedTools: ["Read"],
      permissionMode: "bypassPermissions",
      additionalDirectories: ["/Users/tharshi/GitHub/builtwithopus47/buy-ops/data"],
    },
  });

  for await (const msg of q) {
    if (msg.type === "assistant") {
      let textInThisMsg = "";
      for (const block of msg.message.content) {
        if (block.type === "text") textInThisMsg += block.text;
        if (block.type === "tool_use") {
          toolUses++;
          console.log(`[vision] tool_use: ${block.name} -> ${JSON.stringify(block.input).slice(0, 120)}`);
        }
      }
      if (textInThisMsg.trim().length > 0) lastAssistantText = textInThisMsg;
    }
    if (msg.type === "result") {
      console.log(`[vision] tool calls: ${toolUses}`);
      console.log(`[vision] duration: ${msg.duration_ms}ms (api ${msg.duration_api_ms}ms)`);
      console.log(`[vision] subtype: ${msg.subtype}`);
      console.log(`[vision] last assistant text length: ${lastAssistantText.length}`);
      console.log(`[vision] preview: ${lastAssistantText.slice(0, 300).replace(/\n/g, " ")}...`);

      const rows = tryParseJson(lastAssistantText);
      if (!rows) {
        console.error(`[vision] ✗ FAIL — could not parse JSON array from response`);
        console.error(`--- full response ---\n${lastAssistantText.slice(0, 1500)}\n---`);
        process.exit(1);
      }
      console.log(`\n[vision] ✓ parsed ${rows.length} rows`);

      // Spot-check first 5 and last 3
      console.log(`\nfirst 5:`);
      for (const r of rows.slice(0, 5)) console.log(`  ${JSON.stringify(r)}`);
      if (rows.length > 8) {
        console.log(`...`);
        console.log(`last 3:`);
        for (const r of rows.slice(-3)) console.log(`  ${JSON.stringify(r)}`);
      }

      // Schema validation
      const issues: string[] = [];
      const commoditySet = new Set<string>();
      let nullCost = 0;
      for (const [i, r] of rows.entries()) {
        if (typeof r !== "object" || r === null) {
          issues.push(`#${i}: not an object`);
          continue;
        }
        const o = r as Record<string, unknown>;
        if (typeof o.commodity !== "string" || !o.commodity) issues.push(`#${i}: bad commodity`);
        else commoditySet.add(o.commodity);
        if (o.cost !== null && typeof o.cost !== "number") issues.push(`#${i}: cost not number|null`);
        if (o.cost === null) nullCost++;
        if (typeof o.raw_row_text !== "string" || !o.raw_row_text) issues.push(`#${i}: bad raw_row_text`);
      }

      console.log(`\n[vision] schema check: ${issues.length} issues`);
      if (issues.length > 0) {
        for (const iss of issues.slice(0, 10)) console.log(`  ${iss}`);
      }
      console.log(`[vision] distinct commodities: ${commoditySet.size}`);
      console.log(`[vision] rows with null cost: ${nullCost}`);
      console.log(`[vision] sample commodities: ${Array.from(commoditySet).slice(0, 10).join(", ")}`);

      const ok = rows.length > 10 && issues.length === 0;
      console.log(`\n[vision] ${ok ? "✓ PASS" : "✗ FAIL"} — total wall ${Date.now() - t0}ms`);
      process.exit(ok ? 0 : 1);
    }
  }
}

main().catch((e) => {
  console.error("[vision] threw:", e);
  process.exit(2);
});
