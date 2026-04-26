/**
 * Loads products.csv and formats it for prompt injection.
 * Catalog format: id | name | category | supplier | packSize
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface CatalogProduct {
  id: number;
  name: string;
  category: string;
  supplier: string;
  packSize: string;
}

export interface Catalog {
  products: CatalogProduct[];
  text: string;          // pre-formatted for prompt injection
  count: number;
  versionHash: string;   // sha256 of the source CSV
}

function parseCsvLine(line: string): string[] {
  // Minimal CSV parser handling quoted fields with embedded commas.
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ",") {
        out.push(cur);
        cur = "";
      } else if (ch === '"') {
        inQuote = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

export function loadCatalog(csvPath: string): Catalog {
  const raw = readFileSync(csvPath, "utf-8");
  const versionHash = createHash("sha256").update(raw).digest("hex").slice(0, 16);

  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error(`Catalog CSV at ${csvPath} has no data rows`);
  }

  const header = parseCsvLine(lines[0]!).map((s) => s.trim());
  const idIdx = header.indexOf("id");
  const nameIdx = header.indexOf("name");
  const categoryIdx = header.indexOf("category");
  const supplierIdx = header.indexOf("supplier");
  const packSizeIdx = header.indexOf("packSize");

  if (idIdx < 0 || nameIdx < 0 || packSizeIdx < 0) {
    throw new Error(
      `Catalog CSV missing required columns. Found: ${header.join(", ")}`,
    );
  }

  const products: CatalogProduct[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]!);
    const idStr = cols[idIdx];
    if (!idStr) continue;
    const id = parseInt(idStr, 10);
    if (isNaN(id)) continue;
    products.push({
      id,
      name: cols[nameIdx] ?? "",
      category: cols[categoryIdx] ?? "",
      supplier: cols[supplierIdx] ?? "",
      packSize: cols[packSizeIdx] ?? "",
    });
  }

  // Format as a fixed-width-ish text table for the prompt
  const text = products
    .map(
      (p) =>
        `${String(p.id).padStart(4)} | ${p.name} | ${p.category} | ${p.supplier} | ${p.packSize}`,
    )
    .join("\n");

  return {
    products,
    text,
    count: products.length,
    versionHash,
  };
}
