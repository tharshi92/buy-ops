import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_CHAT_LOGS } from "@/lib/runs";

export const dynamic = "force-dynamic";

/**
 * Returns chat log text. If ?asof=YYYY-MM-DD is provided, filters out any
 * timestamped block whose date is strictly after asof. A "block" begins with
 * a line starting `[YYYY-MM-DD,` and continues until the next such line.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  if (!/^supplier-[a-z]_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.txt$/.test(filename)) {
    return NextResponse.json({ error: "invalid filename" }, { status: 400 });
  }
  const path = join(CORPUS_CHAT_LOGS, filename);
  if (!existsSync(path)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const raw = readFileSync(path, "utf-8");
  const asof = req.nextUrl.searchParams.get("asof");
  if (!asof || !/^\d{4}-\d{2}-\d{2}$/.test(asof)) {
    return new NextResponse(raw, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const headerRe = /^\[(\d{4}-\d{2}-\d{2}),/;
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  let keep = true;
  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) {
      keep = m[1]! <= asof;
    }
    if (keep) out.push(line);
  }
  return new NextResponse(out.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
