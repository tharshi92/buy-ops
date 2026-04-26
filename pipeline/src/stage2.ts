/**
 * Stage 2 — normalization with validators + repair loop.
 * Catalog is cached on the system block; vision is NOT used (raw rows are
 * the authority by this point).
 */

import {
  stage2NormalizeSystem,
  validatorCBlindSystem,
  validatorDJustifySystem,
  tiebreakerS2System,
} from "./prompts.js";
import {
  SUBMIT_NORMALIZATION,
  SUBMIT_BLIND_MATCHES,
  SUBMIT_JUSTIFICATION_VERDICTS,
  SUBMIT_STAGE2_TIEBREAKER_DECISION,
} from "./tools.js";
import { callTool, type UserContentBlock } from "./client.js";
import type { Catalog } from "./catalog.js";
import type {
  ExtractionResult,
  NormalizationResult,
  BlindMatchesResult,
  BlindMatch,
  JustificationVerdictsResult,
  JustificationAudit,
  Stage2TiebreakerResult,
  CallCost,
  NormalizationMapping,
} from "./types.js";
import type { AggregatedStage2Issues } from "./audit.js";
import { itemIdFor } from "./stage1.js";

const CHUNK_SIZE = 100;
const MAX_REPAIR_ITERATIONS = 2;

const MODEL = "claude-opus-4-7";

// =============================================================================
// Public types
// =============================================================================

export interface Stage2Options {
  items: Array<{ item_id: string; item: ExtractionResult["items"][number] }>;
  catalog: Catalog;
  maxRepairIterations?: number;
}

export interface Stage2Iteration {
  iteration_index: number;
  normalize: {
    prompt_hash: string;
    response: NormalizationResult;
    cost: CallCost;
  };
  validator_c_runs: Array<{
    chunk_index: number;
    prompt_hash: string;
    response: BlindMatchesResult;
    cost: CallCost;
  }>;
  validator_d_runs: Array<{
    chunk_index: number;
    prompt_hash: string;
    response: JustificationVerdictsResult;
    cost: CallCost;
  }>;
  tiebreakers: Array<{
    item_id: string;
    dispute_pattern: string;
    prompt_hash: string;
    response: Stage2TiebreakerResult;
    cost: CallCost;
  }>;
  aggregated_verdict: {
    pass: boolean;
    issue_count: number;
    issues: AggregatedStage2Issues;
  };
  /** item_id -> Stage 2 mapping */
  mappings_by_item: Map<string, NormalizationMapping>;
  /** item_id -> Validator C blind match */
  c_by_item: Map<string, BlindMatch>;
  /** item_id -> Validator D audit */
  d_by_item: Map<string, JustificationAudit>;
  /** item_id -> tiebreaker (if invoked) */
  tiebreaker_by_item: Map<string, Stage2TiebreakerResult>;
}

export interface Stage2Result {
  iterations: Stage2Iteration[];
  final_status: "passed" | "max_iterations_exceeded";
}

// =============================================================================
// Public API
// =============================================================================

export async function runStage2(opts: Stage2Options): Promise<Stage2Result> {
  const maxRepair = opts.maxRepairIterations ?? MAX_REPAIR_ITERATIONS;
  const iterations: Stage2Iteration[] = [];
  let priorIssuesXml: string | null = null;

  for (let i = 0; i <= maxRepair; i++) {
    const iter = await runStage2Iteration({
      iterationIndex: i,
      items: opts.items,
      catalog: opts.catalog,
      priorIssuesXml,
    });
    iterations.push(iter);

    if (iter.aggregated_verdict.pass) break;
    if (i === maxRepair) break;

    priorIssuesXml = distillStage2PriorIssuesXml(iter);
  }

  const last = iterations[iterations.length - 1]!;
  return {
    iterations,
    final_status: last.aggregated_verdict.pass ? "passed" : "max_iterations_exceeded",
  };
}

// =============================================================================
// One iteration
// =============================================================================

async function runStage2Iteration(args: {
  iterationIndex: number;
  items: Stage2Options["items"];
  catalog: Catalog;
  priorIssuesXml: string | null;
}): Promise<Stage2Iteration> {
  // ---- 1. NORMALIZE ----
  const rowsBlock = args.items
    .map(
      ({ item_id, item }, i) =>
        `[${i + 1}] item_id=${item_id.slice(0, 8)} commodity="${item.commodity}" variety=${item.variety ? `"${item.variety}"` : "null"} packsize=${item.packsize ? `"${item.packsize}"` : "null"} origin=${item.origin ? `"${item.origin}"` : "null"} price=${item.price ? `"${item.price}"` : "null"} raw="${item.raw_row_text}"`,
    )
    .join("\n");

  const normalizeUserText =
    `<rows>\n${rowsBlock}\n</rows>` +
    (args.priorIssuesXml ? `\n\n${args.priorIssuesXml}` : "");

  const normalizeCall = await callTool<NormalizationResult>({
    role: `stage2_normalize_iter${args.iterationIndex}`,
    systemPrompt: stage2NormalizeSystem(args.catalog.text, args.catalog.count),
    userContent: [{ type: "text", text: normalizeUserText }],
    tool: SUBMIT_NORMALIZATION,
    model: MODEL,
  });

  const mappings = normalizeCall.toolInput.mappings;
  const mappingsByItem = new Map<string, NormalizationMapping>();
  for (const m of mappings) {
    mappingsByItem.set(itemIdFor(m.raw_row_text), m);
  }

  // ---- 2. VALIDATORS C + D IN PARALLEL ----
  const itemChunks = chunk(args.items, CHUNK_SIZE);

  const validatorCPromises = itemChunks.map(async (chunkItems, chunkIdx) => {
    const chunkRows = chunkItems
      .map(
        ({ item }, i) =>
          `[${i + 1}] commodity="${item.commodity}" variety=${item.variety ? `"${item.variety}"` : "null"} packsize=${item.packsize ? `"${item.packsize}"` : "null"} origin=${item.origin ? `"${item.origin}"` : "null"} raw="${item.raw_row_text}"`,
      )
      .join("\n");
    const userText = `<rows>\n${chunkRows}\n</rows>\n\nDerive the best catalog match for each row independently. You have NOT been shown any prior attempt.`;
    const call = await callTool<BlindMatchesResult>({
      role: `validator_c_iter${args.iterationIndex}_chunk${chunkIdx}`,
      systemPrompt: validatorCBlindSystem(args.catalog.text, args.catalog.count),
      userContent: [{ type: "text", text: userText }],
      tool: SUBMIT_BLIND_MATCHES,
      model: MODEL,
    });
    return {
      chunk_index: chunkIdx,
      prompt_hash: call.promptHash,
      response: call.toolInput,
      cost: call.cost,
    };
  });

  const validatorDPromises = itemChunks.map(async (chunkItems, chunkIdx) => {
    const chunkMappings = chunkItems
      .map(({ item_id, item }, i) => {
        const m = mappingsByItem.get(item_id);
        return `[${i + 1}] raw="${item.raw_row_text}" matched_product_id=${m?.matched_product_id ?? "null"} confidence=${m?.confidence ?? "null"} reasoning="${(m?.reasoning ?? "").replaceAll('"', "'")}"`;
      })
      .join("\n");
    const userText = `<proposed_mappings>\n${chunkMappings}\n</proposed_mappings>\n\nFor each mapping, audit commodity / variety / packsize alignment independently. Argue against the mapping; default to skepticism.`;
    const call = await callTool<JustificationVerdictsResult>({
      role: `validator_d_iter${args.iterationIndex}_chunk${chunkIdx}`,
      systemPrompt: validatorDJustifySystem(args.catalog.text, args.catalog.count),
      userContent: [{ type: "text", text: userText }],
      tool: SUBMIT_JUSTIFICATION_VERDICTS,
      model: MODEL,
    });
    return {
      chunk_index: chunkIdx,
      prompt_hash: call.promptHash,
      response: call.toolInput,
      cost: call.cost,
    };
  });

  const [validatorCRuns, validatorDRuns] = await Promise.all([
    Promise.all(validatorCPromises),
    Promise.all(validatorDPromises),
  ]);

  const cByItem = new Map<string, BlindMatch>();
  for (const run of validatorCRuns) {
    for (const m of run.response.matches) {
      cByItem.set(itemIdFor(m.raw_row_text), m);
    }
  }
  const dByItem = new Map<string, JustificationAudit>();
  for (const run of validatorDRuns) {
    for (const a of run.response.audits) {
      dByItem.set(itemIdFor(a.raw_row_text), a);
    }
  }

  // ---- 3. TIEBREAKER DETECTION + DISPATCH ----
  const tiebreakerJobs = detectStage2Tiebreakers(args.items, mappingsByItem, cByItem, dByItem);

  const tiebreakerByItem = new Map<string, Stage2TiebreakerResult>();
  const tiebreakerResults: Stage2Iteration["tiebreakers"] = [];
  if (tiebreakerJobs.length > 0) {
    const promises = tiebreakerJobs.map(async (job) => {
      const call = await callTool<Stage2TiebreakerResult>({
        role: `tiebreaker_s2_iter${args.iterationIndex}_${job.itemId.slice(0, 8)}`,
        systemPrompt: tiebreakerS2System(args.catalog.text, args.catalog.count),
        userContent: [{ type: "text", text: job.userMessage }],
        tool: SUBMIT_STAGE2_TIEBREAKER_DECISION,
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
    for (const r of results) tiebreakerByItem.set(r.item_id, r.response);
  }

  // ---- 4. PASS/FAIL ----
  const issues = aggregateStage2Issues(mappingsByItem, cByItem, dByItem);
  const issueCount =
    issues.match_disagreement_count +
    issues.dimension_failure_count +
    issues.null_dispute_count +
    issues.wrong_null_count +
    issues.force_match_count +
    issues.miscalibrated_confidence_count;

  const pass = issueCount === 0;

  return {
    iteration_index: args.iterationIndex,
    normalize: {
      prompt_hash: normalizeCall.promptHash,
      response: normalizeCall.toolInput,
      cost: normalizeCall.cost,
    },
    validator_c_runs: validatorCRuns,
    validator_d_runs: validatorDRuns,
    tiebreakers: tiebreakerResults,
    aggregated_verdict: { pass, issue_count: issueCount, issues },
    mappings_by_item: mappingsByItem,
    c_by_item: cByItem,
    d_by_item: dByItem,
    tiebreaker_by_item: tiebreakerByItem,
  };
}

// =============================================================================
// Tiebreaker detection
// =============================================================================

interface Stage2TiebreakerJob {
  itemId: string;
  disputePattern: "S2-MATCH_DISAGREEMENT" | "S2-DIMENSION_FAILURE" | "S2-NULL_DISPUTE";
  userMessage: string;
}

function detectStage2Tiebreakers(
  items: Stage2Options["items"],
  mappings: Map<string, NormalizationMapping>,
  cMap: Map<string, BlindMatch>,
  dMap: Map<string, JustificationAudit>,
): Stage2TiebreakerJob[] {
  const jobs: Stage2TiebreakerJob[] = [];

  for (const { item_id, item } of items) {
    const m = mappings.get(item_id);
    const c = cMap.get(item_id);
    const d = dMap.get(item_id);
    if (!m || !c || !d) continue;

    const isMediumOrHigh = (conf: string | undefined) => conf === "high" || conf === "medium";

    // S2-MATCH_DISAGREEMENT: stage2 vs C disagree
    if (
      m.matched_product_id !== c.best_product_id &&
      isMediumOrHigh(m.confidence) &&
      isMediumOrHigh(c.confidence)
    ) {
      jobs.push({
        itemId: item_id,
        disputePattern: "S2-MATCH_DISAGREEMENT",
        userMessage: buildStage2DisputeMsg("S2-MATCH_DISAGREEMENT", item, m, c, d),
      });
      continue;
    }

    // S2-DIMENSION_FAILURE: stage2 + C agree but D flags a dimension mismatch
    if (
      m.matched_product_id === c.best_product_id &&
      m.matched_product_id !== null &&
      (d.verdict === "COMMODITY_MISMATCH" ||
        d.verdict === "VARIETY_MISMATCH" ||
        d.verdict === "PACKSIZE_MISMATCH")
    ) {
      jobs.push({
        itemId: item_id,
        disputePattern: "S2-DIMENSION_FAILURE",
        userMessage: buildStage2DisputeMsg("S2-DIMENSION_FAILURE", item, m, c, d),
      });
      continue;
    }

    // S2-NULL_DISPUTE: stage2 picked null and C did not (or vice versa)
    const stage2Null = m.matched_product_id === null;
    const cNull = c.best_product_id === null;
    if (stage2Null !== cNull && (isMediumOrHigh(m.confidence) || isMediumOrHigh(c.confidence))) {
      jobs.push({
        itemId: item_id,
        disputePattern: "S2-NULL_DISPUTE",
        userMessage: buildStage2DisputeMsg("S2-NULL_DISPUTE", item, m, c, d),
      });
      continue;
    }
  }

  return jobs;
}

function buildStage2DisputeMsg(
  pattern: string,
  item: ExtractionResult["items"][number],
  m: NormalizationMapping,
  c: BlindMatch,
  d: JustificationAudit,
): string {
  return (
    `<dispute_pattern>${pattern}</dispute_pattern>\n\n` +
    `<raw_row>\n  raw_row_text: "${item.raw_row_text}"\n  commodity: "${item.commodity}"\n  variety: ${item.variety ? `"${item.variety}"` : "null"}\n  packsize: ${item.packsize ? `"${item.packsize}"` : "null"}\n  origin: ${item.origin ? `"${item.origin}"` : "null"}\n  price: ${item.price ? `"${item.price}"` : "null"}\n</raw_row>\n\n` +
    `<stage2_position>\n  matched_product_id: ${m.matched_product_id ?? "null"}\n  confidence: ${m.confidence}\n  reasoning: "${m.reasoning.replaceAll('"', "'")}"\n</stage2_position>\n\n` +
    `<validator_c_position>\n  best_product_id: ${c.best_product_id ?? "null"}\n  confidence: ${c.confidence}\n  reasoning: "${c.reasoning.replaceAll('"', "'")}"\n</validator_c_position>\n\n` +
    `<validator_d_position>\n  proposed_product_id: ${d.proposed_product_id ?? "null"}\n  verdict: ${d.verdict}\n  dimension_checks: { commodity: ${d.dimension_checks.commodity}, variety: ${d.dimension_checks.variety}, packsize: ${d.dimension_checks.packsize} }\n  argument_against: "${(d.argument_against ?? "").replaceAll('"', "'")}"\n  suggested_alternative: ${d.suggested_alternative ?? "null"}\n</validator_d_position>`
  );
}

// =============================================================================
// Issue aggregation
// =============================================================================

function aggregateStage2Issues(
  mappings: Map<string, NormalizationMapping>,
  cMap: Map<string, BlindMatch>,
  dMap: Map<string, JustificationAudit>,
): AggregatedStage2Issues {
  let matchDisagreement = 0;
  let dimensionFailure = 0;
  let nullDispute = 0;
  let miscalibrated = 0;
  let wrongNull = 0;
  let forceMatch = 0;

  const isMidPlus = (c: string | undefined) => c === "high" || c === "medium";

  for (const [id, m] of mappings) {
    const c = cMap.get(id);
    const d = dMap.get(id);

    if (c && m.matched_product_id !== c.best_product_id && isMidPlus(m.confidence) && isMidPlus(c.confidence)) {
      matchDisagreement++;
    }
    if (c && (m.matched_product_id === null) !== (c.best_product_id === null)) {
      nullDispute++;
    }
    if (d) {
      if (
        d.verdict === "COMMODITY_MISMATCH" ||
        d.verdict === "VARIETY_MISMATCH" ||
        d.verdict === "PACKSIZE_MISMATCH"
      ) {
        dimensionFailure++;
      }
      if (d.verdict === "MISCALIBRATED_CONFIDENCE") miscalibrated++;
      if (d.verdict === "WRONG_NULL") wrongNull++;
      if (d.verdict === "FORCE_MATCH") forceMatch++;
    }
  }

  return {
    match_disagreement_count: matchDisagreement,
    dimension_failure_count: dimensionFailure,
    null_dispute_count: nullDispute,
    miscalibrated_confidence_count: miscalibrated,
    wrong_null_count: wrongNull,
    force_match_count: forceMatch,
  };
}

// =============================================================================
// Repair: Stage 2 prior_issues XML
// =============================================================================

function distillStage2PriorIssuesXml(iter: Stage2Iteration): string {
  const lines: string[] = [`<prior_issues iteration="${iter.iteration_index}">`];

  // wrong_match: where C disagreed with stage2
  const wrongMatches: Array<{ id: string; m: NormalizationMapping; c: BlindMatch }> = [];
  for (const [id, m] of iter.mappings_by_item) {
    const c = iter.c_by_item.get(id);
    if (!c) continue;
    if (m.matched_product_id !== c.best_product_id) {
      const tb = iter.tiebreaker_by_item.get(id);
      if (tb && tb.decision === "ADOPT_STAGE2_PICK") continue;
      wrongMatches.push({ id, m, c });
    }
  }
  if (wrongMatches.length > 0) {
    lines.push("  <wrong_match>");
    wrongMatches.forEach((wm, i) => {
      lines.push(
        `    <issue id="wm${i + 1}">`,
        `      <stage2_pick>${wm.m.matched_product_id ?? "null"}</stage2_pick>`,
        `      <c_pick>${wm.c.best_product_id ?? "null"}</c_pick>`,
        `      <c_reasoning>${escapeXml(wm.c.reasoning)}</c_reasoning>`,
        `    </issue>`,
      );
    });
    lines.push("  </wrong_match>");
  }

  // dimension_mismatch from D
  const dims: Array<{ id: string; d: JustificationAudit }> = [];
  for (const [id, d] of iter.d_by_item) {
    if (d.verdict === "COMMODITY_MISMATCH" || d.verdict === "VARIETY_MISMATCH" || d.verdict === "PACKSIZE_MISMATCH") {
      dims.push({ id, d });
    }
  }
  if (dims.length > 0) {
    lines.push("  <dimension_mismatch>");
    dims.forEach((dm, i) => {
      lines.push(
        `    <issue id="dm${i + 1}">`,
        `      <verdict>${dm.d.verdict}</verdict>`,
        `      <argument_against>${escapeXml(dm.d.argument_against ?? "")}</argument_against>`,
        `      <suggested_alternative>${dm.d.suggested_alternative ?? "null"}</suggested_alternative>`,
        `    </issue>`,
      );
    });
    lines.push("  </dimension_mismatch>");
  }

  // wrong_null
  const wrongNulls: Array<{ id: string; d: JustificationAudit }> = [];
  for (const [id, d] of iter.d_by_item) {
    if (d.verdict === "WRONG_NULL") wrongNulls.push({ id, d });
  }
  if (wrongNulls.length > 0) {
    lines.push("  <wrong_null>");
    wrongNulls.forEach((wn, i) => {
      lines.push(
        `    <issue id="wn${i + 1}">`,
        `      <suggested_id>${wn.d.suggested_alternative ?? "null"}</suggested_id>`,
        `    </issue>`,
      );
    });
    lines.push("  </wrong_null>");
  }

  // force_match
  const forceMatches: Array<{ id: string; d: JustificationAudit }> = [];
  for (const [id, d] of iter.d_by_item) {
    if (d.verdict === "FORCE_MATCH") forceMatches.push({ id, d });
  }
  if (forceMatches.length > 0) {
    lines.push("  <force_match>");
    forceMatches.forEach((fm, i) => {
      lines.push(
        `    <issue id="fm${i + 1}">`,
        `      <argument_against>${escapeXml(fm.d.argument_against ?? "")}</argument_against>`,
        `    </issue>`,
      );
    });
    lines.push("  </force_match>");
  }

  // tiebreaker rulings
  if (iter.tiebreakers.length > 0) {
    lines.push("  <tiebreaker_rulings>");
    for (const tb of iter.tiebreakers) {
      lines.push(
        `    <ruling for_item="${tb.item_id.slice(0, 8)}">`,
        `      <decision>${tb.response.decision}</decision>`,
        `      <final_product_id>${tb.response.final_product_id ?? "null"}</final_product_id>`,
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
// Helpers
// =============================================================================

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
