import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PRE_BAKED_EXTRACTIONS } from "@/lib/runs";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ doc_id: string }> },
) {
  const { doc_id } = await params;
  if (!/^supplier-[a-z](?:-pt\d+)?-\d{4}-\d{2}-\d{2}$/.test(doc_id)) {
    return NextResponse.json({ error: "invalid doc_id" }, { status: 400 });
  }
  const path = join(PRE_BAKED_EXTRACTIONS, `${doc_id}.json`);
  if (!existsSync(path)) {
    return NextResponse.json({ error: "not extracted" }, { status: 404 });
  }
  try {
    const doc = JSON.parse(readFileSync(path, "utf-8"));
    return NextResponse.json(doc);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
