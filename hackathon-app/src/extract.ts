/**
 * Single-file coarse extraction. Reads any supported format (PDF, TXT, CSV)
 * via the Agent SDK + Claude Code linkage, returns rows in the locked schema.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "node:fs";
import type { ExtractionDoc } from "./types.js";

const PROMPT_TEMPLATE = (filePath: string) => `
Use the Read tool ONCE to read the file at:
${filePath}

This is a wholesale produce supplier price list.

Extract every product offering row. For each row return one JSON object:
  - "commodity": broad category in CAPS, taken from the row's section header or
    the row's lead word. Examples: "BANANAS", "GRAPES", "LEMONS", "CHERRIES",
    "ROMAINE LETTUCE", "CUCUMBERS", "PEPPERS". Pick the closest distinct
    commodity word. Use plural where natural.
  - "cost": numeric USD/CAD price as a number (no $ sign). For ranges or
    multi-tier prices, use the LOWEST. For PTF, TOS, blank, "call", or no
    price → null.
  - "raw_row_text": the verbatim text of the row, including ALL tokens
    (variety, packsize, brand, grade, origin, status, notes). One line.

SKIP these row types entirely (do not include them):
  - Labor charges, surcharges, fuel fees, fees, deposits
  - Packaging materials sold as line items (wrap, boxes, bags, pallets) UNLESS
    they're produce sold in those packages
  - Store credits, returns, blanks, decorative banner text
  - Section headers themselves (the headers inform "commodity" but aren't rows)

Do NOT use any other tool. Read the file once, then respond.

Return ONLY a JSON array of objects, nothing else. No prose. No commentary.
No markdown code fences. The first character must be \`[\` and the last must
be \`]\`. Example shape:
[
  {"commodity": "BANANAS", "cost": 32.00, "raw_row_text": "BANANA #1 DOLE 32.00"},
  {"commodity": "GRAPES", "cost": null, "raw_row_text": "GRAPE THOMPSON SDLS PTF"}
]
`.trim();

function tryParseJson(text: string): Array<Record<string, unknown>> | null {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1]!.trim();
  try {
    const parsed = JSON.parse(t);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
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

export async function extractFromFile(meta: {
  doc_id: string;
  supplier: string;
  date: string;
  source_path: string;
  format: "pdf" | "txt" | "csv";
  additional_dirs?: string[];
}): Promise<ExtractionDoc> {
  const { doc_id, supplier, date, source_path, format, additional_dirs } = meta;

  if (!existsSync(source_path)) {
    return {
      doc_id, supplier, date, source_path, format,
      duration_ms: 0, row_count: 0, rows: [], error: "file not found",
    };
  }

  const t0 = Date.now();
  let lastText = "";
  let success = false;

  try {
    const q = query({
      prompt: PROMPT_TEMPLATE(source_path),
      options: {
        model: "claude-opus-4-7",
        maxTurns: 4,
        allowedTools: ["Read"],
        permissionMode: "bypassPermissions",
        additionalDirectories: additional_dirs,
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
      if (msg.type === "result") {
        success = msg.subtype === "success";
        break;
      }
    }
  } catch (e) {
    return {
      doc_id, supplier, date, source_path, format,
      duration_ms: Date.now() - t0, row_count: 0, rows: [],
      error: `query threw: ${(e as Error).message}`,
    };
  }

  const duration_ms = Date.now() - t0;

  if (!success) {
    return {
      doc_id, supplier, date, source_path, format,
      duration_ms, row_count: 0, rows: [],
      error: `query did not succeed (last text: ${lastText.slice(0, 200)})`,
    };
  }

  const parsed = tryParseJson(lastText);
  if (!parsed) {
    return {
      doc_id, supplier, date, source_path, format,
      duration_ms, row_count: 0, rows: [],
      error: `could not parse JSON array (last text: ${lastText.slice(0, 200)})`,
    };
  }

  const rows: ExtractionDoc["rows"] = [];
  for (const r of parsed) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    const commodity = typeof o.commodity === "string" ? o.commodity.trim() : "";
    if (!commodity) continue;
    const cost =
      o.cost === null || typeof o.cost === "number"
        ? (o.cost as number | null)
        : null;
    const raw_row_text =
      typeof o.raw_row_text === "string" ? o.raw_row_text : "";
    if (!raw_row_text) continue;
    rows.push({ commodity, cost, raw_row_text });
  }

  // sanity: file size for reporting
  void readFileSync(source_path).byteLength;

  return {
    doc_id, supplier, date, source_path, format,
    duration_ms, row_count: rows.length, rows,
  };
}
