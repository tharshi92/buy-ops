import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "@/lib/runs";
import type { Brief } from "@/lib/buy-planner";

export const dynamic = "force-dynamic";

const BRIEFS_DIR = join(APP_ROOT, "data", "briefs");

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ day: string }> },
) {
  try {
    const { day } = await ctx.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return NextResponse.json({ error: "bad day" }, { status: 400 });
    }
    const path = join(BRIEFS_DIR, `${day}.json`);
    if (!existsSync(path)) {
      return NextResponse.json(
        { error: `no brief baked for ${day} (run scripts/run_buy_planner.ts ${day})` },
        { status: 404 },
      );
    }
    const brief = JSON.parse(readFileSync(path, "utf-8")) as Brief;
    return NextResponse.json(brief);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
