/**
 * Loads the 8 prompts from prompts/*.md at startup.
 * Catalog-bearing prompts are exposed as builder functions that substitute
 * {{CATALOG_TEXT}} and {{CATALOG_COUNT}} placeholders.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "..", "prompts");

function load(name: string): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf-8");
}

// Static prompts (no catalog needed)
export const STAGE1_EXTRACT_SYSTEM = load("stage1_extract");
export const VALIDATOR_A_PIXEL_SYSTEM = load("validator_a_pixel");
export const VALIDATOR_B_COMPLETENESS_SYSTEM = load("validator_b_completeness");
export const TIEBREAKER_S1_SYSTEM = load("tiebreaker_s1");

// Catalog-bearing prompts: load template once, substitute on demand
const STAGE2_NORMALIZE_TEMPLATE = load("stage2_normalize");
const VALIDATOR_C_BLIND_TEMPLATE = load("validator_c_blind");
const VALIDATOR_D_JUSTIFY_TEMPLATE = load("validator_d_justify");
const TIEBREAKER_S2_TEMPLATE = load("tiebreaker_s2");

function substitute(template: string, catalogText: string, catalogCount: number): string {
  return template
    .replaceAll("{{CATALOG_TEXT}}", catalogText)
    .replaceAll("{{CATALOG_COUNT}}", String(catalogCount));
}

export function stage2NormalizeSystem(catalogText: string, catalogCount: number): string {
  return substitute(STAGE2_NORMALIZE_TEMPLATE, catalogText, catalogCount);
}

export function validatorCBlindSystem(catalogText: string, catalogCount: number): string {
  return substitute(VALIDATOR_C_BLIND_TEMPLATE, catalogText, catalogCount);
}

export function validatorDJustifySystem(catalogText: string, catalogCount: number): string {
  return substitute(VALIDATOR_D_JUSTIFY_TEMPLATE, catalogText, catalogCount);
}

export function tiebreakerS2System(catalogText: string, catalogCount: number): string {
  return substitute(TIEBREAKER_S2_TEMPLATE, catalogText, catalogCount);
}
