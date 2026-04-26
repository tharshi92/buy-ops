export type CoarseRow = {
  doc_id: string;                  // filename stem, e.g. "supplier-n-2026-04-24"
  supplier: string;                // canonical supplier id, e.g. "supplier-n"
  effective_start: string;         // YYYY-MM-DD — first day this price is valid (= the doc's publish date)
  effective_end: string | null;    // YYYY-MM-DD — last day this price is valid; null if it's the supplier's latest list
  row_idx: number;                 // 0-based sequential position within the doc
  commodity: string;               // CAPS broad category, e.g. "BANANAS", "GRAPES"
  cost: number | null;             // canonical USD/CAD price; lowest of range/tier; null for PTF/TOS/blank
  raw_row_text: string;            // verbatim source line, full context preserved
};

export type CoarseOfferings = Record<string, CoarseRow[]>;

export type ExtractionDoc = {
  doc_id: string;
  supplier: string;
  date: string;
  source_path: string;
  format: "pdf" | "txt" | "csv";
  duration_ms: number;
  row_count: number;
  rows: Array<Pick<CoarseRow, "commodity" | "cost" | "raw_row_text">>;
  error?: string;
};
