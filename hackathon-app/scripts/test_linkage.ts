/**
 * Phase 0 — Check 1a: minimal "does the Agent SDK + Claude Code linkage work"
 * test. Sends a one-token prompt, expects a coherent reply.
 *
 * Run: npx tsx scripts/test_linkage.ts
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  const t0 = Date.now();
  let reply = "";
  let sessionId = "";

  const q = query({
    prompt: "Reply with exactly the word: PONG",
    options: {
      model: "claude-opus-4-7",
      maxTurns: 1,
      allowedTools: [],
      permissionMode: "bypassPermissions",
    },
  });

  for await (const msg of q) {
    if (msg.type === "assistant") {
      sessionId = msg.session_id;
      for (const block of msg.message.content) {
        if (block.type === "text") reply += block.text;
      }
    }
    if (msg.type === "result") {
      console.log(`[linkage] reply: ${reply.trim()}`);
      console.log(`[linkage] session: ${sessionId}`);
      console.log(`[linkage] duration: ${msg.duration_ms}ms (api ${msg.duration_api_ms}ms)`);
      console.log(`[linkage] subtype: ${msg.subtype}`);
      const ok = reply.trim().toUpperCase().includes("PONG");
      console.log(`[linkage] ${ok ? "✓ PASS" : "✗ FAIL"} — total wall ${Date.now() - t0}ms`);
      process.exit(ok ? 0 : 1);
    }
  }
}

main().catch((e) => {
  console.error("[linkage] threw:", e);
  process.exit(2);
});
