import { NextRequest, NextResponse } from "next/server";
import { loadDemoDays, loadSampleManifest } from "@/lib/runs";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const day = url.searchParams.get("day");

    if (!day) {
      const days = loadDemoDays();
      return NextResponse.json({ days: Object.keys(days).sort() });
    }

    const manifest = loadSampleManifest(day);
    return NextResponse.json(manifest);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
