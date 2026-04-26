/**
 * Audit record — accumulated by the orchestrator across the run, persisted as JSON.
 * Hackathon-shaped: captures the essentials (request hashes, raw responses,
 * verdicts, costs, final canonical rows). The full schema from docs/pipeline.html
 * can be expanded later without breaking the file format.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type {
  CallCost,
  ExtractionResult,
  PixelVerdictsResult,
  CompletenessVerdict,
  NormalizationResult,
  BlindMatchesResult,
  JustificationVerdictsResult,
  Stage1TiebreakerResult,
  Stage2TiebreakerResult,
} from "./types.js";

export interface AuditRecord {
  audit_id: string;
  document_id: string;
  schema_version: string;
  pipeline_version: string;
  ingested_at: string;
  models: { extractor: string; validator_a: string; validator_b: string;
            normalizer: string; validator_c: string; validator_d: string;
            tiebreaker_s1: string; tiebreaker_s2: string };
  document: {
    filename: string;
    file_size_bytes: number;
    content_hash: string;
    mime_type: string;
  };

  stage1: {
    iterations: Array<{
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
    }>;
    final_status: "passed" | "max_iterations_exceeded" | "extractor_returned_empty";
  };

  stage2: {
    catalog_version: string;
    catalog_row_count: number;
    iterations: Array<{
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
    }>;
    final_status: "passed" | "max_iterations_exceeded" | "skipped";
  };

  final: {
    supplier: { name: string | null; evidence: string };
    effective_dates: ExtractionResult["effective_dates"];
    canonical_rows: CanonicalRow[];
  };

  metrics: {
    total_calls: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cache_read_tokens: number;
    total_cache_creation_tokens: number;
    total_latency_ms: number;
    iteration_count: { stage1: number; stage2: number };
  };

  status: "committed" | "needs_human_review" | "failed";
  notes: string[];
}

export interface AggregatedStage1Issues {
  hallucinated_count: number;
  field_error_count: number;
  uncertain_count: number;
  missed_row_count: number;
  misclassified_count: number;
  missed_status_flag_count: number;
  supplier_mismatch: boolean;
  dates_mismatch: boolean;
}

export interface AggregatedStage2Issues {
  match_disagreement_count: number;
  dimension_failure_count: number;
  null_dispute_count: number;
  miscalibrated_confidence_count: number;
  wrong_null_count: number;
  force_match_count: number;
}

export interface CanonicalRow {
  item_id: string;
  raw_row_text: string;
  section: string | null;
  commodity: string;
  variety: string | null;
  packsize: string | null;
  origin?: string | null;
  code?: string | null;
  price?: string | null;
  notes?: string | null;
  matched_product_id: number | null;
  confidence: "high" | "medium" | "low" | null;
  match_reasoning: string | null;
  provenance: {
    extracted_in_iteration: number;
    validator_a_verdict: string | null;
    validator_a_page_quote: string | null;
    on_validator_b_missed_list: boolean;
    normalized_in_iteration: number | null;
    validator_c_agreed: boolean | null;
    validator_c_pick: number | null;
    validator_d_verdict: string | null;
    tiebreaker_invoked: boolean;
  };
  human_review_flags: string[];
}

export function writeAuditRecord(record: AuditRecord, outDir: string): {
  auditPath: string;
  canonicalPath: string;
} {
  mkdirSync(outDir, { recursive: true });
  const ts = record.ingested_at.replace(/[:.]/g, "-");
  const safeName = record.document.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const auditPath = join(outDir, `${ts}_${safeName}.audit.json`);
  const canonicalPath = join(outDir, `${ts}_${safeName}.canonical.json`);

  writeFileSync(auditPath, JSON.stringify(record, null, 2));
  writeFileSync(canonicalPath, JSON.stringify(record.final.canonical_rows, null, 2));

  return { auditPath, canonicalPath };
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
