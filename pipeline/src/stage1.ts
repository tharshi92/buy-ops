/**
 * Stage 1 — extraction with validators + repair loop.
 *
 * Flow per iteration:
 *   1. Extract (Opus + vision + tool)
 *   2. In parallel: Validator A (per ≤100-row chunk) + Validator B (one call)
 *   3. Aggregate verdicts; detect tiebreaker triggers
 *   4. Dispatch any tiebreakers in parallel
 *   5. Compute pass/fail; if fail and iteration < MAX, distill issues -> repair
 */

import { createHash } from "node:crypto";
import {
  STAGE1_EXTRACT_SYSTEM,
  VALIDATOR_A_PIXEL_SYSTEM,
  VALIDATOR_B_COMPLETENESS_SYSTEM,
  TIEBREAKER_S1_SYSTEM,
} from "./prompts.js";
import {
  SUBMIT_EXTRACTION,
  SUBMIT_PIXEL_VERDICTS,
  SUBMIT_COMPLETENESS_VERDICT,
  SUBMIT_STAGE1_TIEBREAKER_DECISION,
} from "./tools.js";
import { callTool, type UserContentBlock } from "./client.js";
import type {
  ExtractionResult,
  PixelVerdictsResult,
  PixelVerdict,
  CompletenessVerdict,
  Stage1TiebreakerResult,
  CallCost,
} from "./types.js";
import type { AggregatedStage1Issues } from "./audit.js";

const CHUNK_SIZE = 100;
const MAX_REPAIR_ITERATIONS = 2;
const TIEBREAKER_CAP_PCT = 15;

const MODEL = "claude-opus-4-7";

// =============================================================================
// Public types
// =============================================================================

export interface Stage1Options {
  pdfDocBlock: UserContentBlock;
  filename: string;
  todayISODate: string;
  /** Set to 0 to disable repair entirely. */
  maxRepairIterations?: number;
}

export interface Stage1Iteration {
  iteration_index: number;
  extract: {
    prompt_hash: string;
    response: ExtractionResult;
    cost: CallCost;
  };
  validator_a_runs: Array<{
    chunk_index: number;
    item_count: number;
    prompt_hash: string;
    response: PixelVerdictsResult;
    cost: CallCost;
  }>;
  validator_b_run: {
    prompt_hash: string;
    response: CompletenessVerdict;
    cost: CallCost;
  };
  tiebreakers: Array<{
    item_id: string;
    dispute_pattern: string;
    prompt_hash: string;
    response: Stage1TiebreakerResult;
    cost: CallCost;
  }>;
  aggregated_verdict: {
    pass: boolean;
    issue_count: number;
    issues: AggregatedStage1Issues;
  };
  /** Stable item_id -> verdict, for cross-stage joining. */
  item_verdicts: Map<string, PixelVerdict>;
  /** Quickly tells whether a row appears in B's missed_rows lookalikes. */
  missed_set: Set<string>;
  /** Item_ids B says are misclassified (e.g., section headers extracted as items). */
  misclassified_set: Set<string>;
}

export interface Stage1Result {
  iterations: Stage1Iteration[];
  final_status: "passed" | "max_iterations_exceeded" | "extractor_returned_empty";
  final_extraction: ExtractionResult;
  /** After tiebreaker corrections applied (drops/fixes/adds). */
  final_items_with_ids: Array<{ item_id: string; item: ExtractionResult["items"][number] }>;
}

// =============================================================================
// Public API
// =============================================================================

export async function runStage1(opts: Stage1Options): Promise<Stage1Result> {
  const maxRepair = opts.maxRepairIterations ?? MAX_REPAIR_ITERATIONS;
  const iterations: Stage1Iteration[] = [];
  let priorIssuesXml: string | null = null;

  for (let i = 0; i <= maxRepair; i++) {
    const iter = await runStage1Iteration({
      iterationIndex: i,
      pdfDocBlock: opts.pdfDocBlock,
      filename: opts.filename,
      todayISODate: opts.todayISODate,
      priorIssuesXml,
    });
    iterations.push(iter);

    if (iter.extract.response.items.length === 0) {
      return {
        iterations,
        final_status: "extractor_returned_empty",
        final_extraction: iter.extract.response,
        final_items_with_ids: [],
      };
    }

    if (iter.aggregated_verdict.pass) break;
    if (i === maxRepair) break;

    // Build prior_issues for the repair iteration
    priorIssuesXml = distillPriorIssuesXml(iter);
  }

  const last = iterations[iterations.length - 1]!;
  const finalStatus = last.aggregated_verdict.pass ? "passed" : "max_iterations_exceeded";
  const finalItems = applyTiebreakerCorrections(last);

  return {
    iterations,
    final_status: finalStatus,
    final_extraction: last.extract.response,
    final_items_with_ids: finalItems,
  };
}

// =============================================================================
// One iteration
// =============================================================================

async function runStage1Iteration(args: {
  iterationIndex: number;
  pdfDocBlock: UserContentBlock;
  filename: string;
  todayISODate: string;
  priorIssuesXml: string | null;
}): Promise<Stage1Iteration> {
  // ---- 1. EXTRACT ----
  const extractContent: UserContentBlock[] = [
    { type: "text", text: `<context today="${args.todayISODate}"/>\n<filename>${escapeXml(args.filename)}</filename>` },
    args.pdfDocBlock,
  ];
  if (args.priorIssuesXml) {
    extractContent.push({ type: "text", text: args.priorIssuesXml });
  }

  const extractCall = await callTool<ExtractionResult>({
    role: `stage1_extract_iter${args.iterationIndex}`,
    systemPrompt: STAGE1_EXTRACT_SYSTEM,
    userContent: extractContent,
    tool: SUBMIT_EXTRACTION,
    model: MODEL,
  });

  const extraction = extractCall.toolInput;

  // Early exit on empty extraction
  if (extraction.items.length === 0) {
    return {
      iteration_index: args.iterationIndex,
      extract: { prompt_hash: extractCall.promptHash, response: extraction, cost: extractCall.cost },
      validator_a_runs: [],
      validator_b_run: {
        prompt_hash: "",
        response: emptyCompleteness(),
        cost: zeroCost(),
      },
      tiebreakers: [],
      aggregated_verdict: {
        pass: false,
        issue_count: 1,
        issues: emptyIssues({ supplier_mismatch: false, dates_mismatch: false }),
      },
      item_verdicts: new Map(),
      missed_set: new Set(),
      misclassified_set: new Set(),
    };
  }

  // ---- 2. VALIDATORS A + B IN PARALLEL ----
  const itemChunks = chunk(extraction.items, CHUNK_SIZE);

  const validatorAPromises = itemChunks.map(async (chunkItems, chunkIdx) => {
    const chunkText = chunkItems
      .map((item, i) => `[${i + 1}] ${item.raw_row_text}`)
      .join("\n");
    const userContent: UserContentBlock[] = [
      args.pdfDocBlock,
      {
        type: "text",
        text: `Document filename: ${args.filename}\n\nReview these ${chunkItems.length} extracted rows against the page images. For each, locate it on the page and verify every field literally appears there.\n\n<rows>\n${chunkText}\n</rows>`,
      },
    ];
    const call = await callTool<PixelVerdictsResult>({
      role: `validator_a_iter${args.iterationIndex}_chunk${chunkIdx}`,
      systemPrompt: VALIDATOR_A_PIXEL_SYSTEM,
      userContent,
      tool: SUBMIT_PIXEL_VERDICTS,
      model: MODEL,
    });
    return {
      chunk_index: chunkIdx,
      item_count: chunkItems.length,
      prompt_hash: call.promptHash,
      response: call.toolInput,
      cost: call.cost,
    };
  });

  const validatorBPromise = (async () => {
    const rawRowList = extraction.items
      .map((item, i) => `[${i + 1}] ${item.raw_row_text}`)
      .join("\n");
    const userContent: UserContentBlock[] = [
      args.pdfDocBlock,
      {
        type: "text",
        text:
          `Document filename: ${args.filename}\n` +
          `Extractor reported supplier: ${extraction.supplier.name ?? "(null)"}\n` +
          `Extractor reported effective_dates: start=${extraction.effective_dates.effective_start ?? "null"}, end=${extraction.effective_dates.effective_end ?? "null"}, source_text="${extraction.effective_dates.source_text ?? ""}"\n\n` +
          `Extractor produced ${extraction.items.length} rows. Their raw_row_text strings are:\n\n<extracted_rows>\n${rawRowList}\n</extracted_rows>\n\n` +
          `Independently audit the document for completeness, classification errors, missed status flags, and supplier/date mismatches.`,
      },
    ];
    const call = await callTool<CompletenessVerdict>({
      role: `validator_b_iter${args.iterationIndex}`,
      systemPrompt: VALIDATOR_B_COMPLETENESS_SYSTEM,
      userContent,
      tool: SUBMIT_COMPLETENESS_VERDICT,
      model: MODEL,
    });
    return {
      prompt_hash: call.promptHash,
      response: call.toolInput,
      cost: call.cost,
    };
  })();

  const [validatorARuns, validatorBRun] = await Promise.all([
    Promise.all(validatorAPromises),
    validatorBPromise,
  ]);

  // ---- 3. AGGREGATE ----
  const itemVerdicts = new Map<string, PixelVerdict>();
  for (const run of validatorARuns) {
    for (const v of run.response.verdicts) {
      itemVerdicts.set(itemIdFor(v.raw_row_text), v);
    }
  }

  const missedSet = new Set<string>(
    validatorBRun.response.missed_rows.map((m) => normalizeForMatch(m.page_quote)),
  );
  const misclassifiedSet = new Set<string>(
    validatorBRun.response.misclassified_rows.map((m) => itemIdFor(m.raw_row_text)),
  );

  // ---- 4. TIEBREAKER DETECTION + DISPATCH ----
  const tiebreakerJobs = detectStage1Tiebreakers(
    extraction,
    itemVerdicts,
    validatorBRun.response,
  );

  const tiebreakerCount = tiebreakerJobs.length;
  const totalRows = extraction.items.length;
  const overCap = (tiebreakerCount / totalRows) * 100 > TIEBREAKER_CAP_PCT;

  const tiebreakerResults: Stage1Iteration["tiebreakers"] = [];
  if (!overCap && tiebreakerJobs.length > 0) {
    const promises = tiebreakerJobs.map(async (job) => {
      const userContent: UserContentBlock[] = [
        args.pdfDocBlock,
        { type: "text", text: job.userMessage },
      ];
      const call = await callTool<Stage1TiebreakerResult>({
        role: `tiebreaker_s1_iter${args.iterationIndex}_${job.itemId.slice(0, 8)}`,
        systemPrompt: TIEBREAKER_S1_SYSTEM,
        userContent,
        tool: SUBMIT_STAGE1_TIEBREAKER_DECISION,
        model: MODEL,
      });
      return {
        item_id: job.itemId,
        dispute_pattern: job.disputePattern,
        prompt_hash: call.promptHash,
        response: call.toolInput,
        cost: call.cost,
      };
    });
    const results = await Promise.all(promises);
    tiebreakerResults.push(...results);
  }

  // ---- 5. COMPUTE PASS/FAIL ----
  const issues = aggregateIssues(itemVerdicts, validatorBRun.response);
  const issueCount =
    issues.hallucinated_count +
    issues.field_error_count +
    issues.missed_row_count +
    issues.misclassified_count +
    issues.missed_status_flag_count +
    (issues.supplier_mismatch ? 1 : 0) +
    (issues.dates_mismatch ? 1 : 0);

  const pass = issueCount === 0 && !overCap;

  return {
    iteration_index: args.iterationIndex,
    extract: {
      prompt_hash: extractCall.promptHash,
      response: extraction,
      cost: extractCall.cost,
    },
    validator_a_runs: validatorARuns,
    validator_b_run: validatorBRun,
    tiebreakers: tiebreakerResults,
    aggregated_verdict: { pass, issue_count: issueCount, issues },
    item_verdicts: itemVerdicts,
    missed_set: missedSet,
    misclassified_set: misclassifiedSet,
  };
}

// =============================================================================
// Tiebreaker detection
// =============================================================================

interface TiebreakerJob {
  itemId: string;
  disputePattern: "S1-HALLUCINATION" | "S1-FIELD_DISPUTE" | "S1-PHANTOM_MISS";
  userMessage: string;
}

function detectStage1Tiebreakers(
  extraction: ExtractionResult,
  itemVerdicts: Map<string, PixelVerdict>,
  bVerdict: CompletenessVerdict,
): TiebreakerJob[] {
  const jobs: TiebreakerJob[] = [];

  const missedNormalized = new Set(
    bVerdict.missed_rows.map((m) => normalizeForMatch(m.page_quote)),
  );
  const misclassifiedSet = new Set(
    bVerdict.misclassified_rows.map((m) => itemIdFor(m.raw_row_text)),
  );

  for (const item of extraction.items) {
    const id = itemIdFor(item.raw_row_text);
    const av = itemVerdicts.get(id);
    if (!av) continue;

    if (av.verdict === "HALLUCINATED") {
      // Tiebreaker fires if B did NOT also flag this row as missed/misclassified
      const inBMissed = missedNormalized.has(normalizeForMatch(item.raw_row_text));
      const inBMisclassified = misclassifiedSet.has(id);
      if (!inBMissed && !inBMisclassified) {
        jobs.push({
          itemId: id,
          disputePattern: "S1-HALLUCINATION",
          userMessage:
            `<dispute_pattern>S1-HALLUCINATION</dispute_pattern>\n\n` +
            `<extracted_row>\n  raw_row_text: "${escapeText(item.raw_row_text)}"\n  commodity: "${escapeText(item.commodity)}"\n  variety: ${item.variety ? `"${escapeText(item.variety)}"` : "null"}\n  packsize: ${item.packsize ? `"${escapeText(item.packsize)}"` : "null"}\n</extracted_row>\n\n` +
            `<validator_a_position>\n  verdict: HALLUCINATED\n  page_quote: ${av.page_quote ? `"${escapeText(av.page_quote)}"` : "null"}\n</validator_a_position>\n\n` +
            `<validator_b_position>\n  this row was NOT in validator B's missed_rows list\n  this row was NOT in validator B's misclassified_rows list\n  (B implicitly accepted it or never specifically considered it)\n</validator_b_position>`,
        });
      }
    }

    if (av.verdict === "FIELD_ERROR" && av.field_errors && av.field_errors.length > 0) {
      // Only fire on price/code disputes (highest stakes); others get reported but not arbitrated
      const priceError = av.field_errors.find((f) => f.field === "price" || f.field === "code");
      if (priceError) {
        jobs.push({
          itemId: id,
          disputePattern: "S1-FIELD_DISPUTE",
          userMessage:
            `<dispute_pattern>S1-FIELD_DISPUTE</dispute_pattern>\n\n` +
            `<extracted_row>\n  raw_row_text: "${escapeText(item.raw_row_text)}"\n  ${priceError.field}: ${priceError.extracted_value ? `"${escapeText(priceError.extracted_value)}"` : "null"}\n</extracted_row>\n\n` +
            `<validator_a_position>\n  verdict: FIELD_ERROR\n  page_quote: ${av.page_quote ? `"${escapeText(av.page_quote)}"` : "null"}\n  field: ${priceError.field}\n  extracted_value: ${priceError.extracted_value ? `"${escapeText(priceError.extracted_value)}"` : "null"}\n  actual_page_value: ${priceError.actual_page_value ? `"${escapeText(priceError.actual_page_value)}"` : "null"}\n</validator_a_position>`,
        });
      }
    }
  }

  return jobs;
}

// =============================================================================
// Issue aggregation
// =============================================================================

function aggregateIssues(
  itemVerdicts: Map<string, PixelVerdict>,
  bVerdict: CompletenessVerdict,
): AggregatedStage1Issues {
  let hallucinated = 0;
  let fieldErrors = 0;
  let uncertain = 0;
  for (const v of itemVerdicts.values()) {
    if (v.verdict === "HALLUCINATED") hallucinated++;
    else if (v.verdict === "FIELD_ERROR") fieldErrors++;
    else if (v.verdict === "UNCERTAIN") uncertain++;
  }

  return {
    hallucinated_count: hallucinated,
    field_error_count: fieldErrors,
    uncertain_count: uncertain,
    missed_row_count: bVerdict.missed_rows.length,
    misclassified_count: bVerdict.misclassified_rows.length,
    missed_status_flag_count: bVerdict.missed_status_flags.length,
    supplier_mismatch: !bVerdict.supplier_check.agrees,
    dates_mismatch: !bVerdict.effective_dates_check.agrees,
  };
}

// =============================================================================
// Repair: distill issues into a <prior_issues> XML block
// =============================================================================

function distillPriorIssuesXml(iter: Stage1Iteration): string {
  const lines: string[] = [`<prior_issues iteration="${iter.iteration_index}">`];

  // Tiebreaker rulings supersede individual validator claims
  const tiebreakerByItem = new Map(iter.tiebreakers.map((t) => [t.item_id, t.response]));

  // Missed rows from B (not superseded by tiebreaker REJECT)
  if (iter.validator_b_run.response.missed_rows.length > 0) {
    lines.push("  <missed_rows>");
    iter.validator_b_run.response.missed_rows.forEach((m, i) => {
      lines.push(
        `    <issue id="mr${i + 1}">`,
        `      <page_quote>${escapeXml(m.page_quote)}</page_quote>`,
        `      <location_hint>${escapeXml(m.location_hint)}</location_hint>`,
        `      <reported_by>validator_b</reported_by>`,
        `    </issue>`,
      );
    });
    lines.push("  </missed_rows>");
  }

  // Hallucinated rows from A (where tiebreaker confirmed DROP, not KEEP)
  const hallucinations: Array<{ item_id: string; item: PixelVerdict }> = [];
  for (const [id, v] of iter.item_verdicts) {
    if (v.verdict !== "HALLUCINATED") continue;
    const tb = tiebreakerByItem.get(id);
    if (tb && tb.decision === "KEEP_EXTRACTED_ROW") continue;
    hallucinations.push({ item_id: id, item: v });
  }
  if (hallucinations.length > 0) {
    lines.push("  <hallucinated_rows>");
    hallucinations.forEach((h, i) => {
      lines.push(
        `    <issue id="h${i + 1}">`,
        `      <claimed_row>${escapeXml(h.item.raw_row_text)}</claimed_row>`,
        `      <reasoning>not located on the page</reasoning>`,
        `      <reported_by>validator_a</reported_by>`,
        `    </issue>`,
      );
    });
    lines.push("  </hallucinated_rows>");
  }

  // Field errors from A
  const fieldErrors: Array<{ item: PixelVerdict; err: NonNullable<PixelVerdict["field_errors"]>[number] }> = [];
  for (const v of iter.item_verdicts.values()) {
    if (v.verdict !== "FIELD_ERROR" || !v.field_errors) continue;
    for (const err of v.field_errors) fieldErrors.push({ item: v, err });
  }
  if (fieldErrors.length > 0) {
    lines.push("  <field_errors>");
    fieldErrors.forEach((fe, i) => {
      lines.push(
        `    <issue id="fe${i + 1}">`,
        `      <row>${escapeXml(fe.item.raw_row_text)}</row>`,
        `      <field>${escapeXml(fe.err.field)}</field>`,
        `      <extracted_value>${escapeXml(fe.err.extracted_value ?? "null")}</extracted_value>`,
        `      <actual_page_value>${escapeXml(fe.err.actual_page_value ?? "null")}</actual_page_value>`,
        `      <reported_by>validator_a</reported_by>`,
        `    </issue>`,
      );
    });
    lines.push("  </field_errors>");
  }

  // Misclassified rows from B
  if (iter.validator_b_run.response.misclassified_rows.length > 0) {
    lines.push("  <misclassified_rows>");
    iter.validator_b_run.response.misclassified_rows.forEach((m, i) => {
      lines.push(
        `    <issue id="mc${i + 1}">`,
        `      <claimed_row>${escapeXml(m.raw_row_text)}</claimed_row>`,
        `      <actual_role>${m.actual_role}</actual_role>`,
        `      <reported_by>validator_b</reported_by>`,
        `    </issue>`,
      );
    });
    lines.push("  </misclassified_rows>");
  }

  // Missed status flags
  if (iter.validator_b_run.response.missed_status_flags.length > 0) {
    lines.push("  <missed_status_flags>");
    iter.validator_b_run.response.missed_status_flags.forEach((m, i) => {
      lines.push(
        `    <issue id="msf${i + 1}">`,
        `      <row>${escapeXml(m.raw_row_text)}</row>`,
        `      <missing_flag>${escapeXml(m.missing_flag)}</missing_flag>`,
        `    </issue>`,
      );
    });
    lines.push("  </missed_status_flags>");
  }

  // Supplier / dates corrections
  if (!iter.validator_b_run.response.supplier_check.agrees) {
    lines.push(
      `  <supplier_correction>`,
      `    <validator_b_says>${escapeXml(iter.validator_b_run.response.supplier_check.correction ?? "")}</validator_b_says>`,
      `    <page_evidence>${escapeXml(iter.validator_b_run.response.supplier_check.page_evidence)}</page_evidence>`,
      `  </supplier_correction>`,
    );
  }
  if (!iter.validator_b_run.response.effective_dates_check.agrees) {
    lines.push(
      `  <dates_correction>`,
      `    <validator_b_says>${escapeXml(iter.validator_b_run.response.effective_dates_check.correction ?? "")}</validator_b_says>`,
      `    <page_evidence>${escapeXml(iter.validator_b_run.response.effective_dates_check.page_evidence)}</page_evidence>`,
      `  </dates_correction>`,
    );
  }

  // Tiebreaker rulings
  if (iter.tiebreakers.length > 0) {
    lines.push("  <tiebreaker_rulings>");
    for (const tb of iter.tiebreakers) {
      lines.push(
        `    <ruling for_item="${tb.item_id.slice(0, 8)}">`,
        `      <decision>${tb.response.decision}</decision>`,
        `      <reasoning>${escapeXml(tb.response.reasoning)}</reasoning>`,
        `    </ruling>`,
      );
    }
    lines.push("  </tiebreaker_rulings>");
  }

  lines.push("</prior_issues>");
  return lines.join("\n");
}

// =============================================================================
// Tiebreaker corrections -> final items
// =============================================================================

function applyTiebreakerCorrections(iter: Stage1Iteration): Array<{
  item_id: string;
  item: ExtractionResult["items"][number];
}> {
  const tiebreakerByItem = new Map(iter.tiebreakers.map((t) => [t.item_id, t.response]));
  const out: Array<{ item_id: string; item: ExtractionResult["items"][number] }> = [];

  for (const item of iter.extract.response.items) {
    const id = itemIdFor(item.raw_row_text);
    const tb = tiebreakerByItem.get(id);

    if (tb?.decision === "DROP_EXTRACTED_ROW") continue;

    if (tb?.decision === "KEEP_EXTRACTED_ROW_WITH_FIELD_FIX" && tb.field_corrections) {
      const fixed = { ...item };
      for (const fc of tb.field_corrections) {
        // safe field assignment
        (fixed as Record<string, unknown>)[fc.field] = fc.correct_value;
      }
      out.push({ item_id: id, item: fixed });
      continue;
    }

    out.push({ item_id: id, item });
  }

  // Also append any rows tiebreaker says to ADD
  for (const tb of iter.tiebreakers) {
    if (tb.response.decision === "ADD_MISSED_ROW" && tb.response.added_row) {
      const added = tb.response.added_row;
      out.push({ item_id: itemIdFor(added.raw_row_text), item: added });
    }
  }

  return out;
}

// =============================================================================
// Helpers
// =============================================================================

export function itemIdFor(rawRowText: string): string {
  return createHash("sha256").update(rawRowText).digest("hex").slice(0, 16);
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeText(s: string): string {
  return s.replaceAll('"', '\\"');
}

function emptyCompleteness(): CompletenessVerdict {
  return {
    missed_rows: [],
    misclassified_rows: [],
    missed_status_flags: [],
    supplier_check: { agrees: true, page_evidence: "" },
    effective_dates_check: { agrees: true, page_evidence: "" },
  };
}

function emptyIssues(over: Partial<AggregatedStage1Issues> = {}): AggregatedStage1Issues {
  return {
    hallucinated_count: 0,
    field_error_count: 0,
    uncertain_count: 0,
    missed_row_count: 0,
    misclassified_count: 0,
    missed_status_flag_count: 0,
    supplier_mismatch: false,
    dates_mismatch: false,
    ...over,
  };
}

function zeroCost(): CallCost {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    latency_ms: 0,
  };
}
