/**
 * 8 tool schemas for the pipeline. Each has tool_choice forced to its
 * specific tool so the model must produce strict JSON conforming to the schema.
 */

import type Anthropic from "@anthropic-ai/sdk";

type Tool = Anthropic.Tool;

// =============================================================================
// Stage 1 — extraction
// =============================================================================

export const SUBMIT_EXTRACTION: Tool = {
  name: "submit_extraction",
  description: "Submit the extracted price list data.",
  input_schema: {
    type: "object",
    required: ["document", "supplier", "effective_dates", "dates_found", "layout_description", "items"],
    properties: {
      document: {
        type: "object",
        required: ["filename", "page_count"],
        properties: {
          filename: { type: "string" },
          page_count: { type: "integer" },
          title_text: { type: ["string", "null"] },
        },
      },
      supplier: {
        type: "object",
        required: ["name", "evidence"],
        properties: {
          name: { type: ["string", "null"] },
          evidence: {
            type: "string",
            description: "what you saw (masthead text, etc.)",
          },
        },
      },
      effective_dates: {
        type: "object",
        required: ["effective_start", "effective_end", "source", "source_text"],
        properties: {
          effective_start: { type: ["string", "null"], format: "date" },
          effective_end: { type: ["string", "null"], format: "date" },
          source: {
            type: "string",
            enum: [
              "document_explicit_range",
              "document_explicit_start",
              "filename_fallback",
              "none",
            ],
          },
          source_text: { type: ["string", "null"] },
          interpretation_note: { type: ["string", "null"] },
        },
      },
      dates_found: {
        type: "array",
        items: {
          type: "object",
          required: ["value", "location", "surrounding_text"],
          properties: {
            value: { type: "string" },
            location: { type: "string" },
            surrounding_text: { type: "string" },
          },
        },
      },
      layout_description: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          required: ["section", "commodity", "variety", "packsize", "raw_row_text"],
          properties: {
            section: { type: ["string", "null"] },
            commodity: { type: "string" },
            variety: { type: ["string", "null"] },
            packsize: { type: ["string", "null"] },
            origin: { type: ["string", "null"] },
            code: { type: ["string", "null"] },
            price: {
              type: ["string", "null"],
              description: "verbatim, not parsed",
            },
            notes: { type: ["string", "null"] },
            raw_row_text: {
              type: "string",
              description: "literal row as one line — audit anchor",
            },
          },
        },
      },
      uncertainties: {
        type: "array",
        items: { type: "string" },
      },
      prior_issues_response: {
        type: ["object", "null"],
        description: "set ONLY on repair iterations (iteration > 0)",
        properties: {
          applied: {
            type: "array",
            items: {
              type: "object",
              required: ["issue_id", "action"],
              properties: {
                issue_id: { type: "string" },
                action: {
                  type: "string",
                  enum: [
                    "added_row",
                    "removed_row",
                    "fixed_field",
                    "reclassified",
                    "added_status_flag",
                    "corrected_supplier",
                    "corrected_dates",
                  ],
                },
                details: { type: "string" },
              },
            },
          },
          overridden: {
            type: "array",
            items: {
              type: "object",
              required: ["issue_id", "reasoning"],
              properties: {
                issue_id: { type: "string" },
                reasoning: { type: "string" },
                page_quote: { type: ["string", "null"] },
              },
            },
          },
        },
      },
    },
  },
};

// =============================================================================
// Validator A — pixel verification
// =============================================================================

export const SUBMIT_PIXEL_VERDICTS: Tool = {
  name: "submit_pixel_verdicts",
  description: "Submit per-row verdicts grounding each extracted row against the page.",
  input_schema: {
    type: "object",
    required: ["verdicts"],
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          required: ["raw_row_text", "verdict", "page_quote"],
          properties: {
            raw_row_text: { type: "string" },
            verdict: {
              type: "string",
              enum: ["VERIFIED", "FIELD_ERROR", "HALLUCINATED", "UNCERTAIN"],
            },
            page_quote: {
              type: ["string", "null"],
              description: "literal text from the page where you located this row, or null if not found",
            },
            field_errors: {
              type: "array",
              items: {
                type: "object",
                required: ["field", "extracted_value", "actual_page_value"],
                properties: {
                  field: { type: "string" },
                  extracted_value: { type: ["string", "null"] },
                  actual_page_value: {
                    type: ["string", "null"],
                    description: "null if field isn't on the page at all (i.e. inferred)",
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

// =============================================================================
// Validator B — completeness audit
// =============================================================================

export const SUBMIT_COMPLETENESS_VERDICT: Tool = {
  name: "submit_completeness_verdict",
  description: "Submit page-side completeness audit.",
  input_schema: {
    type: "object",
    required: [
      "missed_rows",
      "misclassified_rows",
      "missed_status_flags",
      "supplier_check",
      "effective_dates_check",
    ],
    properties: {
      missed_rows: {
        type: "array",
        items: {
          type: "object",
          required: ["page_quote", "location_hint"],
          properties: {
            page_quote: { type: "string" },
            location_hint: {
              type: "string",
              description: "e.g., 'middle column, under \"Peppers\" header'",
            },
          },
        },
      },
      misclassified_rows: {
        type: "array",
        items: {
          type: "object",
          required: ["raw_row_text", "actual_role"],
          properties: {
            raw_row_text: { type: "string" },
            actual_role: {
              type: "string",
              enum: ["section_header", "subtotal", "footnote", "banner", "blank"],
            },
          },
        },
      },
      missed_status_flags: {
        type: "array",
        items: {
          type: "object",
          required: ["raw_row_text", "missing_flag"],
          properties: {
            raw_row_text: { type: "string" },
            missing_flag: {
              type: "string",
              description: "e.g., 'sold out', 'N/A'",
            },
          },
        },
      },
      supplier_check: {
        type: "object",
        required: ["agrees", "page_evidence"],
        properties: {
          agrees: { type: "boolean" },
          page_evidence: { type: "string" },
          correction: { type: ["string", "null"] },
        },
      },
      effective_dates_check: {
        type: "object",
        required: ["agrees", "page_evidence"],
        properties: {
          agrees: { type: "boolean" },
          page_evidence: { type: "string" },
          correction: { type: ["string", "null"] },
        },
      },
    },
  },
};

// =============================================================================
// Stage 2 — normalization
// =============================================================================

export const SUBMIT_NORMALIZATION: Tool = {
  name: "submit_normalization",
  description: "Map each raw extracted row to the canonical product catalog.",
  input_schema: {
    type: "object",
    required: ["mappings"],
    properties: {
      mappings: {
        type: "array",
        items: {
          type: "object",
          required: ["raw_row_text", "matched_product_id", "confidence", "reasoning"],
          properties: {
            raw_row_text: { type: "string" },
            matched_product_id: { type: ["integer", "null"] },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
            },
            reasoning: { type: "string" },
            alternative_candidates: {
              type: "array",
              items: {
                type: "object",
                required: ["product_id", "why"],
                properties: {
                  product_id: { type: "integer" },
                  why: { type: "string" },
                },
              },
            },
          },
        },
      },
      prior_issues_response: {
        type: ["object", "null"],
        description: "set ONLY on repair iterations",
        properties: {
          applied: {
            type: "array",
            items: {
              type: "object",
              required: ["issue_id", "action"],
              properties: {
                issue_id: { type: "string" },
                action: { type: "string" },
                details: { type: "string" },
              },
            },
          },
          overridden: {
            type: "array",
            items: {
              type: "object",
              required: ["issue_id", "reasoning"],
              properties: {
                issue_id: { type: "string" },
                reasoning: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

// =============================================================================
// Validator C — blind re-match
// =============================================================================

export const SUBMIT_BLIND_MATCHES: Tool = {
  name: "submit_blind_matches",
  description: "Independent blind re-derivation of catalog matches.",
  input_schema: {
    type: "object",
    required: ["matches"],
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          required: ["raw_row_text", "best_product_id", "confidence", "reasoning"],
          properties: {
            raw_row_text: { type: "string" },
            best_product_id: { type: ["integer", "null"] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            reasoning: { type: "string" },
            ranked_alternatives: {
              type: "array",
              items: {
                type: "object",
                required: ["product_id", "why"],
                properties: {
                  product_id: { type: "integer" },
                  why: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
};

// =============================================================================
// Validator D — justification audit
// =============================================================================

export const SUBMIT_JUSTIFICATION_VERDICTS: Tool = {
  name: "submit_justification_verdicts",
  description: "Audit each mapping along commodity / variety / packsize dimensions.",
  input_schema: {
    type: "object",
    required: ["audits"],
    properties: {
      audits: {
        type: "array",
        items: {
          type: "object",
          required: ["raw_row_text", "proposed_product_id", "verdict", "dimension_checks"],
          properties: {
            raw_row_text: { type: "string" },
            proposed_product_id: { type: ["integer", "null"] },
            verdict: {
              type: "string",
              enum: [
                "DEFENSIBLE",
                "COMMODITY_MISMATCH",
                "VARIETY_MISMATCH",
                "PACKSIZE_MISMATCH",
                "MISCALIBRATED_CONFIDENCE",
                "FORCE_MATCH",
                "CORRECT_NULL",
                "WRONG_NULL",
              ],
            },
            dimension_checks: {
              type: "object",
              required: ["commodity", "variety", "packsize"],
              properties: {
                commodity: {
                  type: "string",
                  enum: ["aligned", "misaligned", "ambiguous"],
                },
                variety: {
                  type: "string",
                  enum: ["aligned", "misaligned", "ambiguous", "not_applicable"],
                },
                packsize: {
                  type: "string",
                  enum: ["aligned", "misaligned", "ambiguous", "not_applicable"],
                },
              },
            },
            argument_against: {
              type: "string",
              description: "your strongest case for why this mapping might be wrong",
            },
            suggested_alternative: { type: ["integer", "null"] },
          },
        },
      },
    },
  },
};

// =============================================================================
// Stage 1 tiebreaker
// =============================================================================

export const SUBMIT_STAGE1_TIEBREAKER_DECISION: Tool = {
  name: "submit_stage1_tiebreaker_decision",
  description: "Resolve a single Stage 1 extraction dispute.",
  input_schema: {
    type: "object",
    required: ["decision", "independent_finding", "reasoning"],
    properties: {
      decision: {
        type: "string",
        enum: [
          "KEEP_EXTRACTED_ROW",
          "KEEP_EXTRACTED_ROW_WITH_FIELD_FIX",
          "DROP_EXTRACTED_ROW",
          "ADD_MISSED_ROW",
          "REJECT_MISSED_ROW_CLAIM",
          "MERGE_PHANTOM_INTO_VERIFIED",
          "INCONCLUSIVE",
        ],
      },
      independent_finding: {
        type: "string",
        description: "what you actually saw on the page when you re-derived, in 1-2 sentences",
      },
      page_quote: { type: ["string", "null"] },
      field_corrections: {
        type: "array",
        description: "for KEEP_EXTRACTED_ROW_WITH_FIELD_FIX",
        items: {
          type: "object",
          required: ["field", "correct_value"],
          properties: {
            field: { type: "string" },
            correct_value: { type: ["string", "null"] },
          },
        },
      },
      added_row: {
        type: ["object", "null"],
        description: "for ADD_MISSED_ROW: the new row to insert",
        properties: {
          section: { type: ["string", "null"] },
          commodity: { type: "string" },
          variety: { type: ["string", "null"] },
          packsize: { type: ["string", "null"] },
          origin: { type: ["string", "null"] },
          code: { type: ["string", "null"] },
          price: { type: ["string", "null"] },
          notes: { type: ["string", "null"] },
          raw_row_text: { type: "string" },
        },
      },
      reasoning: { type: "string" },
      inconclusive_reason: { type: ["string", "null"] },
    },
  },
};

// =============================================================================
// Stage 2 tiebreaker
// =============================================================================

export const SUBMIT_STAGE2_TIEBREAKER_DECISION: Tool = {
  name: "submit_stage2_tiebreaker_decision",
  description: "Resolve a single Stage 2 normalization dispute.",
  input_schema: {
    type: "object",
    required: ["decision", "independent_finding", "dimension_checks", "reasoning"],
    properties: {
      decision: {
        type: "string",
        enum: [
          "ADOPT_STAGE2_PICK",
          "ADOPT_C_PICK",
          "ADOPT_D_SUGGESTION",
          "ADOPT_NEW_PICK",
          "ADOPT_NULL",
          "INCONCLUSIVE",
        ],
      },
      final_product_id: { type: ["integer", "null"] },
      independent_finding: { type: "string" },
      dimension_checks: {
        type: "object",
        required: ["commodity", "variety", "packsize"],
        properties: {
          commodity: { type: "string", enum: ["aligned", "misaligned", "ambiguous"] },
          variety: {
            type: "string",
            enum: ["aligned", "misaligned", "ambiguous", "not_applicable"],
          },
          packsize: {
            type: "string",
            enum: ["aligned", "misaligned", "ambiguous", "not_applicable"],
          },
        },
      },
      page_region_used: { type: "boolean" },
      reasoning: { type: "string" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      inconclusive_reason: { type: ["string", "null"] },
    },
  },
};
