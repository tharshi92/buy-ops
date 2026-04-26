# buy-ops pipeline (TypeScript harness)

Price-list extraction pipeline. PDF in → verified canonical rows out, with a full audit record.

## Architecture

See `../docs/pipeline.html` for the full diagram. Summary:

```
PDF → Stage 1 extract (Opus + vision)
    → parallel Validators A (pixel verify) + B (completeness audit)
    → optional Stage 1 tiebreaker
    → inter-stage gate (code)
    → Stage 2 normalize against catalog (Opus, catalog cached)
    → parallel Validators C (blind re-match) + D (justification audit)
    → optional Stage 2 tiebreaker
    → final audit record + canonical rows
```

All LLM calls are Opus 4.7 with extended thinking enabled. Tool-use enforces strict JSON.

## Setup

```sh
cd pipeline
npm install
cp .env.example .env
# Edit .env to add your ANTHROPIC_API_KEY
```

## Run on one document

```sh
npm run harness -- ../price_lists/Stronach\ and\ Sons\ Price\ Lists/Price\ List\ April\ 27th.pdf
```

Outputs:
- `runs/<timestamp>_<filename>.audit.json` — full per-document audit record
- `runs/<timestamp>_<filename>.canonical.json` — final canonical rows

## Layout

```
pipeline/
  prompts/                  # 8 prompts as .md (editable without touching code)
    stage1_extract.md
    stage2_normalize.md
    validator_a_pixel.md
    validator_b_completeness.md
    validator_c_blind.md
    validator_d_justify.md
    tiebreaker_s1.md
    tiebreaker_s2.md
  src/
    prompts.ts              # loads .md files; supplies builders for catalog-bearing ones
    tools.ts                # 8 tool schemas
    catalog.ts              # CSV loader for products.csv
    client.ts               # Anthropic SDK wrapper (caching, thinking, tool_choice, cost capture)
    audit.ts                # record types + JSON writer
    types.ts                # shared types
    stage1.ts               # extract + validators + repair
    stage2.ts               # normalize + validators + repair
    orchestrator.ts         # top-level loop
    harness.ts              # CLI entry
  runs/                     # gitignored
```

## Notes

- PDFs are sent as native Anthropic `document` blocks — no pre-rasterization needed.
- Catalog cached on the system block of Stage 2 / Validator C / Validator D / Tiebreaker S2.
- Page images cached on the system or user block of Stage 1 / Validators A / B / Tiebreaker S1.
- Tiebreakers fire only on real validator disagreement; capped at 15% of rows.
- Repair iterations capped at 2.
