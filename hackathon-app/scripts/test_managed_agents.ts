/**
 * Phase 0 — Check 2: Managed Agents hello-world via @anthropic-ai/sdk.
 * Creates an agent + environment + session, sends "PONG" prompt, streams
 * events, asserts the reply, then cleans up.
 *
 * Run: npx tsx scripts/test_managed_agents.ts
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const BETA = "managed-agents-2026-04-01";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set in .env");
    process.exit(2);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const t0 = Date.now();

  // 1. Create agent
  console.log("[managed] creating agent...");
  const agent = await client.beta.agents.create({
    model: "claude-opus-4-7",
    name: "buy-ops-phase0-test",
    description: "Phase 0 hello-world test agent — safe to delete.",
    system: "You are a connectivity test. Reply with the EXACT word: PONG",
    betas: [BETA],
  });
  console.log(`[managed]   agent id: ${agent.id}`);

  // 2. Create environment
  console.log("[managed] creating environment...");
  const env = await client.beta.environments.create({
    name: "buy-ops-phase0-env",
    description: "Phase 0 hello-world test env — safe to delete.",
    betas: [BETA],
  });
  console.log(`[managed]   env id: ${env.id}`);

  // 3. Create session
  console.log("[managed] creating session...");
  const session = await client.beta.sessions.create({
    agent: agent.id,
    environment_id: env.id,
    title: "phase0-hello",
    betas: [BETA],
  });
  console.log(`[managed]   session id: ${session.id}`);

  // 4. Send user message + stream events
  console.log("[managed] sending message and streaming events...");
  const stream = await client.beta.sessions.events.stream(session.id, { betas: [BETA] });

  await client.beta.sessions.events.send(
    session.id,
    {
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text: "Reply with the exact word: PONG" }],
        },
      ],
      betas: [BETA],
    },
  );

  let agentReply = "";
  let sawIdle = false;
  let eventCount = 0;
  const TIMEOUT_MS = 60_000;
  const deadline = Date.now() + TIMEOUT_MS;

  for await (const ev of stream) {
    eventCount++;
    const type = (ev as { type?: string }).type;
    if (type === "agent.message") {
      const msg = ev as { content: Array<{ type: string; text?: string }> };
      for (const b of msg.content) {
        if (b.type === "text" && b.text) agentReply += b.text;
      }
      console.log(`[managed]   agent.message: "${agentReply.trim().slice(0, 80)}"`);
    } else if (type === "session.status_idle") {
      sawIdle = true;
      console.log(`[managed]   session.status_idle (turn complete)`);
      break;
    } else if (type === "session.error" || type === "session.status_terminated") {
      console.error(`[managed]   ✗ session error/terminated:`, JSON.stringify(ev).slice(0, 400));
      break;
    } else {
      console.log(`[managed]   event #${eventCount}: ${type}`);
    }
    if (Date.now() > deadline) {
      console.error(`[managed]   ✗ timeout after ${TIMEOUT_MS}ms`);
      break;
    }
  }

  // 5. Cleanup (archive)
  console.log("[managed] cleaning up...");
  try {
    await client.beta.sessions.delete(session.id, { betas: [BETA] });
  } catch (e) {
    console.log(`[managed]   (session delete skipped: ${(e as Error).message})`);
  }
  try {
    await client.beta.environments.archive(env.id, { betas: [BETA] });
  } catch (e) {
    console.log(`[managed]   (env archive skipped: ${(e as Error).message})`);
  }
  try {
    await client.beta.agents.archive(agent.id, { betas: [BETA] });
  } catch (e) {
    console.log(`[managed]   (agent archive skipped: ${(e as Error).message})`);
  }

  // 6. Verdict
  const ok = sawIdle && agentReply.trim().toUpperCase().includes("PONG");
  console.log(`\n[managed] reply: "${agentReply.trim()}"`);
  console.log(`[managed] events seen: ${eventCount}`);
  console.log(`[managed] ${ok ? "✓ PASS" : "✗ FAIL"} — total wall ${Date.now() - t0}ms`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("[managed] threw:", e);
  process.exit(2);
});
