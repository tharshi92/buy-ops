/**
 * Top-level orchestrator. Wires Stage 1 -> Stage 2 -> final canonical rows
 * and builds the audit record.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { runStage1, itemIdFor } from "./stage1.js";
import { runStage2 } from "./stage2.js";
import { loadPdfAsDocumentBlock, sumCosts } from "./client.js";
import type { Catalog } from "./catalog.js";
import type { AuditRecord, CanonicalRow } from "./audit.js";
import type { CallCost, ExtractionResult, NormalizationMapping, BlindMatch, JustificationAudit, Stage2TiebreakerResult } from "./types.js";

const PIPELINE_VERSION = "0.1.0";
const SCHEMA_VERSION = "1.0.0";
const MODEL = "claude-opus-4-7";

export interface OrchestratorOptions {
  pdfPath: string;
  catalog: Catalog;
  todayISODate?: string;
  /** 0 = no repair iterations. */
  maxRepairIterations?: number;
  /** Skip Stage 2 entirely (Stage 1 only). */
  skipStage2?: boolean;
}

export async function runPipeline(opts: OrchestratorOptions): Promise<AuditRecord> {
  const ingestedAt = new Date().toISOString();
  const today = opts.todayISODate ?? ingestedAt.slice(0, 10);
  const filename = basename(opts.pdfPath);

  // Read file & compute hashes
  const fileBytes = readFileSync(opts.pdfPath);
  const contentHash = createHash("sha256").update(fileBytes).digest("hex");
  const documentId = createHash("sha256")
    .update(`${filename}::${contentHash}`)
    .digest("hex")
    .slice(0, 16);
  const fileSize = statSync(opts.pdfPath).size;

  // Load PDF as document block (used by Stage 1 + validators A/B + tiebreaker S1)
  const pdfDocBlock = loadPdfAsDocumentBlock(opts.pdfPath, { cache: true });

  // ---- STAGE 1 ----
  console.log(`[orch] Stage 1: extracting ${filename}...`);
  const stage1 = await runStage1({
    pdfDocBlock,
    filename,
    todayISODate: today,
    maxRepairIterations: opts.maxRepairIterations,
  });
  console.log(
    `[orch] Stage 1 done. Status: ${stage1.final_status}. Iterations: ${stage1.iterations.length}. Final items: ${stage1.final_items_with_ids.length}.`,
  );

  // ---- STAGE 2 (skip if no items or explicitly disabled) ----
  let stage2Result: Awaited<ReturnType<typeof runStage2>> | null = null;
  if (!opts.skipStage2 && stage1.final_items_with_ids.length > 0) {
    console.log(`[orch] Stage 2: normalizing ${stage1.final_items_with_ids.length} items against catalog...`);
    stage2Result = await runStage2({
      items: stage1.final_items_with_ids,
      catalog: opts.catalog,
      maxRepairIterations: opts.maxRepairIterations,
    });
    console.log(
      `[orch] Stage 2 done. Status: ${stage2Result.final_status}. Iterations: ${stage2Result.iterations.length}.`,
    );
  } else {
    console.log("[orch] Stage 2 skipped.");
  }

  // ---- BUILD CANONICAL ROWS WITH PROVENANCE ----
  const canonicalRows = buildCanonicalRows(stage1, stage2Result);

  // ---- AGGREGATE METRICS ----
  const allCosts: CallCost[] = [];
  let totalCalls = 0;
  for (const it of stage1.iterations) {
    allCosts.push(it.extract.cost);
    totalCalls++;
    for (const r of it.validator_a_runs) {
      allCosts.push(r.cost);
      totalCalls++;
    }
    allCosts.push(it.validator_b_run.cost);
    totalCalls++;
    for (const tb of it.tiebreakers) {
      allCosts.push(tb.cost);
      totalCalls++;
    }
  }
  if (stage2Result) {
    for (const it of stage2Result.iterations) {
      allCosts.push(it.normalize.cost);
      totalCalls++;
      for (const r of it.validator_c_runs) {
        allCosts.push(r.cost);
        totalCalls++;
      }
      for (const r of it.validator_d_runs) {
        allCosts.push(r.cost);
        totalCalls++;
      }
      for (const tb of it.tiebreakers) {
        allCosts.push(tb.cost);
        totalCalls++;
      }
    }
  }
  const summed = sumCosts(allCosts);

  // ---- DETERMINE OVERALL STATUS ----
  const stage1Pass = stage1.final_status === "passed";
  const stage2Pass =
    !stage2Result ||
    stage2Result.final_status === "passed";
  const status: AuditRecord["status"] =
    stage1Pass && stage2Pass
      ? "committed"
      : stage1.final_status === "extractor_returned_empty"
        ? "needs_human_review"
        : "needs_human_review";

  const notes: string[] = [];
  if (!stage1Pass) notes.push(`stage1: ${stage1.final_status}`);
  if (!stage2Pass) notes.push(`stage2: ${stage2Result?.final_status}`);

  // ---- BUILD AUDIT RECORD ----
  const lastStage1 = stage1.iterations[stage1.iterations.length - 1]!;
  const lastStage2 = stage2Result?.iterations[stage2Result.iterations.length - 1] ?? null;

  const record: AuditRecord = {
    audit_id: randomUUID(),
    document_id: documentId,
    schema_version: SCHEMA_VERSION,
    pipeline_version: PIPELINE_VERSION,
    ingested_at: ingestedAt,
    models: {
      extractor: MODEL,
      validator_a: MODEL,
      validator_b: MODEL,
      normalizer: MODEL,
      validator_c: MODEL,
      validator_d: MODEL,
      tiebreaker_s1: MODEL,
      tiebreaker_s2: MODEL,
    },
    document: {
      filename,
      file_size_bytes: fileSize,
      content_hash: contentHash,
      mime_type: "application/pdf",
    },
    stage1: {
      iterations: stage1.iterations.map((it) => ({
        iteration_index: it.iteration_index,
        extract: it.extract,
        validator_a_runs: it.validator_a_runs,
        validator_b_run: it.validator_b_run,
        tiebreakers: it.tiebreakers,
        aggregated_verdict: it.aggregated_verdict,
      })),
      final_status: stage1.final_status,
    },
    stage2: stage2Result
      ? {
          catalog_version: opts.catalog.versionHash,
          catalog_row_count: opts.catalog.count,
          iterations: stage2Result.iterations.map((it) => ({
            iteration_index: it.iteration_index,
            normalize: it.normalize,
            validator_c_runs: it.validator_c_runs,
            validator_d_runs: it.validator_d_runs,
            tiebreakers: it.tiebreakers,
            aggregated_verdict: it.aggregated_verdict,
          })),
          final_status: stage2Result.final_status,
        }
      : {
          catalog_version: opts.catalog.versionHash,
          catalog_row_count: opts.catalog.count,
          iterations: [],
          final_status: "skipped" as const,
        },
    final: {
      supplier: stage1.final_extraction.supplier,
      effective_dates: stage1.final_extraction.effective_dates,
      canonical_rows: canonicalRows,
    },
    metrics: {
      total_calls: totalCalls,
      total_input_tokens: summed.input_tokens,
      total_output_tokens: summed.output_tokens,
      total_cache_read_tokens: summed.cache_read_input_tokens,
      total_cache_creation_tokens: summed.cache_creation_input_tokens,
      total_latency_ms: summed.latency_ms,
      iteration_count: {
        stage1: stage1.iterations.length,
        stage2: stage2Result?.iterations.length ?? 0,
      },
    },
    status,
    notes,
  };

  return record;
}

// =============================================================================
// Build canonical rows with provenance
// =============================================================================

function buildCanonicalRows(
  stage1: Awaited<ReturnType<typeof runStage1>>,
  stage2: Awaited<ReturnType<typeof runStage2>> | null,
): CanonicalRow[] {
  const lastStage1 = stage1.iterations[stage1.iterations.length - 1]!;
  const lastStage2 = stage2?.iterations[stage2.iterations.length - 1] ?? null;

  const rows: CanonicalRow[] = [];

  for (const { item_id, item } of stage1.final_items_with_ids) {
    const aVerdict = lastStage1.item_verdicts.get(item_id);
    const stage2Map = lastStage2?.mappings_by_item.get(item_id);
    const c = lastStage2?.c_by_item.get(item_id);
    const d = lastStage2?.d_by_item.get(item_id);
    const tb1 = lastStage1.tiebreakers.find((t) => t.item_id === item_id);
    const tb2 = lastStage2?.tiebreaker_by_item.get(item_id);

    const flags: string[] = [];
    if (aVerdict?.verdict === "UNCERTAIN") flags.push("validator_a_uncertain");
    if (stage2Map?.confidence === "low") flags.push("stage2_low_confidence");
    if (tb1?.response.decision === "INCONCLUSIVE") flags.push("stage1_tiebreaker_inconclusive");
    if (tb2?.decision === "INCONCLUSIVE") flags.push("stage2_tiebreaker_inconclusive");
    if (c && stage2Map && c.best_product_id !== stage2Map.matched_product_id) {
      flags.push("validator_c_disagreed");
    }
    if (d && d.verdict !== "DEFENSIBLE" && d.verdict !== "CORRECT_NULL") {
      flags.push(`validator_d_${d.verdict.toLowerCase()}`);
    }

    // Apply Stage 2 tiebreaker decision to final mapping if invoked
    let finalProductId = stage2Map?.matched_product_id ?? null;
    if (tb2 && tb2.decision !== "INCONCLUSIVE") {
      finalProductId = tb2.final_product_id;
    }

    rows.push({
      item_id,
      raw_row_text: item.raw_row_text,
      section: item.section,
      commodity: item.commodity,
      variety: item.variety,
      packsize: item.packsize,
      origin: item.origin,
      code: item.code,
      price: item.price,
      notes: item.notes,
      matched_product_id: finalProductId,
      confidence: stage2Map?.confidence ?? null,
      match_reasoning: stage2Map?.reasoning ?? null,
      provenance: {
        extracted_in_iteration: lastStage1.iteration_index,
        validator_a_verdict: aVerdict?.verdict ?? null,
        validator_a_page_quote: aVerdict?.page_quote ?? null,
        on_validator_b_missed_list: false, // accepted rows by definition aren't on B's missed list
        normalized_in_iteration: lastStage2?.iteration_index ?? null,
        validator_c_agreed: c && stage2Map ? c.best_product_id === stage2Map.matched_product_id : null,
        validator_c_pick: c?.best_product_id ?? null,
        validator_d_verdict: d?.verdict ?? null,
        tiebreaker_invoked: !!(tb1 || tb2),
      },
      human_review_flags: flags,
    });
  }

  return rows;
}
