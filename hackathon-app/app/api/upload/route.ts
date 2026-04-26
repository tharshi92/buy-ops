import { NextRequest, NextResponse } from "next/server";
import {
  newRunId,
  stageUploadedFiles,
  buildRunManifestFromDisk,
} from "@/lib/uploads";
import { isDemoMode } from "@/lib/demo-mode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (isDemoMode()) {
    return NextResponse.json(
      { error: "uploads disabled in demo mode — clone the repo to use your own data" },
      { status: 403 },
    );
  }
  try {
    const formData = await req.formData();
    const existingRunId = formData.get("run_id");
    const run_id =
      typeof existingRunId === "string" && existingRunId.length > 0
        ? existingRunId
        : newRunId();

    const files: File[] = [];
    for (const entry of formData.getAll("files")) {
      if (entry instanceof File) files.push(entry);
    }
    if (files.length === 0) {
      return NextResponse.json(
        { error: "no files provided under 'files'" },
        { status: 400 },
      );
    }

    const staged = await stageUploadedFiles(run_id, files);
    const manifest = buildRunManifestFromDisk(run_id);
    return NextResponse.json({ run_id, staged, manifest });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}
