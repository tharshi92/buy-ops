/**
 * Commodity canonicalizer sub-agent. Single Opus call, no tools.
 * Takes the list of distinct commodity names (with row counts), returns a
 * merge map: { source -> canonical, reason }.
 *
 * Designed to be conservative — only merges true equivalents, NOT
 * buyer-distinguishable distinctions (ROMAINE LETTUCE ≠ LETTUCE,
 * CHERRY TOMATOES ≠ TOMATOES, SWEET POTATOES ≠ POTATOES).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

export type Merge = {
  source: string;
  canonical: string;
  reason: string;
};

export type CanonicalizationMap = {
  merges: Merge[];
  generated_at: string;
  input_count: number;
};

const PROMPT = (listing: string) => `
You are a produce-commodity canonicalizer. Below is a list of commodity names
extracted from wholesale produce price lists, with their row counts. Many are
duplicates due to plural forms, varieties promoted to commodity-level, or
descriptive qualifier prefixes.

Your job: produce a merge map so the index is clean, WITHOUT collapsing
buyer-distinguishable distinctions.

RULES (apply in this order):

1) **Merge plural / spelling variants.** Pick the dominant spelling (highest
   row count) as canonical.
   Examples:
   - MANGO + MANGOS + MANGOES → MANGOES (whichever has highest count is canonical)
   - CABBAGE + CABBAGES → CABBAGES
   - KIWI + KIWIS → KIWIS
   - CLEMENTINE + CLEMENTINES → CLEMENTINES

2) **Merge variety-as-commodity strays into the parent commodity.**
   Examples:
   - JALAPENOS, POBLANOS, CUBANELLE → PEPPERS
   - SHANGHAI CHOY → BOK CHOY
   - SNOWPEAS → SNOW PEAS (or PEAS if no SNOW PEAS bucket exists)

3) **Strip qualifier prefixes that aren't buyer-distinguishable.**
   Examples:
   - ORGANIC PEARS → PEARS (only when ORGANIC PEARS has very few rows)
   - GREEN LEAF LETTUCE → LETTUCE
   - ROOT PARSLEY → PARSLEY

DO NOT MERGE THESE — they are buyer-distinguishable, even if they look
mergeable:
  - ROMAINE LETTUCE stays separate from LETTUCE — buyers ask for romaine specifically
  - CHERRY TOMATOES, GRAPE TOMATOES, ROMA TOMATOES stay separate from TOMATOES
  - SWEET POTATOES, BABY POTATOES, RED POTATOES, YUKON POTATOES stay separate from POTATOES
  - HOT PEPPERS, SWEET PEPPERS, BELL PEPPERS stay separate from PEPPERS
    (color-distinguished varieties stay distinct)

If unsure: do NOT add a merge. Conservative is better than over-merging — a
buyer being able to find their exact item matters more than a clean index.

Return ONLY valid JSON, no prose, no markdown fences. Shape:
{
  "merges": [
    {"source": "MANGO",      "canonical": "MANGOES", "reason": "singular form"},
    {"source": "MANGOS",     "canonical": "MANGOES", "reason": "alternate plural"},
    {"source": "JALAPENOS",  "canonical": "PEPPERS", "reason": "specific pepper variety"},
    {"source": "ORGANIC PEARS", "canonical": "PEARS", "reason": "qualifier prefix; few rows"}
  ]
}

Items not appearing as a "source" in any merge are kept as-is. Do not include
self-merges (where source == canonical).

COMMODITIES (row_count → name):
${listing}
`.trim();

export async function canonicalize(
  commodities: Array<{ name: string; row_count: number }>,
): Promise<CanonicalizationMap> {
  const listing = commodities
    .slice()
    .sort((a, b) => b.row_count - a.row_count)
    .map((c) => `  ${c.row_count.toString().padStart(4)}  ${c.name}`)
    .join("\n");

  let lastText = "";

  const q = query({
    prompt: PROMPT(listing),
    options: {
      model: "claude-opus-4-7",
      maxTurns: 1,
      allowedTools: [],
      permissionMode: "bypassPermissions",
    },
  });

  for await (const msg of q) {
    if (msg.type === "assistant") {
      let textInThisMsg = "";
      for (const block of msg.message.content) {
        if (block.type === "text") textInThisMsg += block.text;
      }
      if (textInThisMsg.trim().length > 0) lastText = textInThisMsg;
    }
    if (msg.type === "result") break;
  }

  let t = lastText.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1]!.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("could not find JSON object in response");
    parsed = JSON.parse(t.slice(start, end + 1));
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as Record<string, unknown>).merges)
  ) {
    throw new Error("invalid canonicalization response shape");
  }

  const merges = ((parsed as { merges: unknown[] }).merges as Merge[]).filter(
    (m) =>
      typeof m.source === "string" &&
      typeof m.canonical === "string" &&
      m.source !== m.canonical,
  );

  return {
    merges,
    generated_at: new Date().toISOString(),
    input_count: commodities.length,
  };
}
