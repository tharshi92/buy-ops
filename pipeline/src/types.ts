/**
 * Shared types across the pipeline.
 * Mirrors the tool-use output shapes so we get type safety on results.
 */

// =============================================================================
// Stage 1 — extraction output
// =============================================================================

export interface ExtractedItem {
  section: string | null;
  commodity: string;
  variety: string | null;
  packsize: string | null;
  origin?: string | null;
  code?: string | null;
  price?: string | null;
  notes?: string | null;
  raw_row_text: string;
}

export interface DateObservation {
  value: string;
  location: string;
  surrounding_text: string;
}

export interface EffectiveDates {
  effective_start: string | null;
  effective_end: string | null;
  source:
    | "document_explicit_range"
    | "document_explicit_start"
    | "filename_fallback"
    | "none";
  source_text: string | null;
  interpretation_note?: string | null;
}

export interface SupplierInfo {
  name: string | null;
  evidence: string;
}

export interface ExtractionResult {
  document: {
    filename: string;
    page_count: number;
    title_text?: string | null;
  };
  supplier: SupplierInfo;
  effective_dates: EffectiveDates;
  dates_found: DateObservation[];
  layout_description: string;
  items: ExtractedItem[];
  uncertainties?: string[];
  prior_issues_response?: PriorIssuesResponse | null;
}

export interface PriorIssuesResponse {
  applied: Array<{ issue_id: string; action: string; details?: string }>;
  overridden: Array<{ issue_id: string; reasoning: string; page_quote?: string | null }>;
}

// =============================================================================
// Validator A — pixel verdicts
// =============================================================================

export type PixelVerdictLabel = "VERIFIED" | "FIELD_ERROR" | "HALLUCINATED" | "UNCERTAIN";

export interface PixelVerdict {
  raw_row_text: string;
  verdict: PixelVerdictLabel;
  page_quote: string | null;
  field_errors?: Array<{
    field: string;
    extracted_value: string | null;
    actual_page_value: string | null;
  }>;
}

export interface PixelVerdictsResult {
  verdicts: PixelVerdict[];
}

// =============================================================================
// Validator B — completeness verdict
// =============================================================================

export interface CompletenessVerdict {
  missed_rows: Array<{ page_quote: string; location_hint: string }>;
  misclassified_rows: Array<{
    raw_row_text: string;
    actual_role: "section_header" | "subtotal" | "footnote" | "banner" | "blank";
  }>;
  missed_status_flags: Array<{ raw_row_text: string; missing_flag: string }>;
  supplier_check: {
    agrees: boolean;
    page_evidence: string;
    correction?: string | null;
  };
  effective_dates_check: {
    agrees: boolean;
    page_evidence: string;
    correction?: string | null;
  };
}

// =============================================================================
// Stage 2 — normalization
// =============================================================================

export type Confidence = "high" | "medium" | "low";

export interface NormalizationMapping {
  raw_row_text: string;
  matched_product_id: number | null;
  confidence: Confidence;
  reasoning: string;
  alternative_candidates?: Array<{ product_id: number; why: string }>;
}

export interface NormalizationResult {
  mappings: NormalizationMapping[];
  prior_issues_response?: PriorIssuesResponse | null;
}

// =============================================================================
// Validator C — blind matches
// =============================================================================

export interface BlindMatch {
  raw_row_text: string;
  best_product_id: number | null;
  confidence: Confidence;
  reasoning: string;
  ranked_alternatives?: Array<{ product_id: number; why: string }>;
}

export interface BlindMatchesResult {
  matches: BlindMatch[];
}

// =============================================================================
// Validator D — justification audits
// =============================================================================

export type JustificationVerdictLabel =
  | "DEFENSIBLE"
  | "COMMODITY_MISMATCH"
  | "VARIETY_MISMATCH"
  | "PACKSIZE_MISMATCH"
  | "MISCALIBRATED_CONFIDENCE"
  | "FORCE_MATCH"
  | "CORRECT_NULL"
  | "WRONG_NULL";

export interface JustificationAudit {
  raw_row_text: string;
  proposed_product_id: number | null;
  verdict: JustificationVerdictLabel;
  dimension_checks: {
    commodity: "aligned" | "misaligned" | "ambiguous";
    variety: "aligned" | "misaligned" | "ambiguous" | "not_applicable";
    packsize: "aligned" | "misaligned" | "ambiguous" | "not_applicable";
  };
  argument_against?: string;
  suggested_alternative?: number | null;
}

export interface JustificationVerdictsResult {
  audits: JustificationAudit[];
}

// =============================================================================
// Tiebreakers
// =============================================================================

export type Stage1TiebreakerDecision =
  | "KEEP_EXTRACTED_ROW"
  | "KEEP_EXTRACTED_ROW_WITH_FIELD_FIX"
  | "DROP_EXTRACTED_ROW"
  | "ADD_MISSED_ROW"
  | "REJECT_MISSED_ROW_CLAIM"
  | "MERGE_PHANTOM_INTO_VERIFIED"
  | "INCONCLUSIVE";

export interface Stage1TiebreakerResult {
  decision: Stage1TiebreakerDecision;
  independent_finding: string;
  page_quote?: string | null;
  field_corrections?: Array<{ field: string; correct_value: string | null }>;
  added_row?: ExtractedItem | null;
  reasoning: string;
  inconclusive_reason?: string | null;
}

export type Stage2TiebreakerDecision =
  | "ADOPT_STAGE2_PICK"
  | "ADOPT_C_PICK"
  | "ADOPT_D_SUGGESTION"
  | "ADOPT_NEW_PICK"
  | "ADOPT_NULL"
  | "INCONCLUSIVE";

export interface Stage2TiebreakerResult {
  decision: Stage2TiebreakerDecision;
  final_product_id: number | null;
  independent_finding: string;
  dimension_checks: JustificationAudit["dimension_checks"];
  page_region_used?: boolean;
  reasoning: string;
  confidence: Confidence;
  inconclusive_reason?: string | null;
}

// =============================================================================
// Cost tracking (per call)
// =============================================================================

export interface CallCost {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  latency_ms: number;
}

export interface CallRecord<T> {
  role: string;
  prompt_hash: string;
  response_raw: T;
  cost: CallCost;
  started_at: string;
  finished_at: string;
}
