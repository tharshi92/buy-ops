/**
 * Demo mode gate.
 *
 * When DEMO_MODE=true (set in the public deploy env), the app:
 *  - Hides the upload dropzone in the UI
 *  - Returns 403 from /api/upload and /api/run-agent
 *  - Renders only pre-baked briefs (no live agent calls possible)
 *
 * Goal: public deploy has zero Anthropic-API spend surface.
 */

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "true" || process.env.NEXT_PUBLIC_DEMO_MODE === "true";
}

export const DEMO_MODE_HEADER = "X-Demo-Mode";
