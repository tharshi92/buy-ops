/**
 * SSE endpoint: stream item-by-item agent decisions as runBuyPlanner runs.
 *
 *   GET /api/run-brief/2026-04-23?limit=8&concurrency=4
 *
 * Events (each as `data: <json>\n\n`):
 *   { type: "started", total, day }
 *   { type: "item", decision, idx, total }
 *   { type: "done", brief }
 *   { type: "error", message }
 *
 * Used by the dashboard's "Run live" button. The pre-baked path
 * (`/api/brief/[day]`) is the demo safety net; this is the wow-factor view
 * showing agents working in real time, gated by `limit` so the demo finishes
 * fast.
 */

import { listOpenOrders } from "@/lib/agent-tools";
import { runBuyPlanner } from "@/lib/buy-planner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ day: string }> },
) {
  const { day } = await ctx.params;
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const concurrencyRaw = url.searchParams.get("concurrency");
  const limit = limitRaw ? Math.max(1, parseInt(limitRaw, 10)) : undefined;
  const concurrency = concurrencyRaw ? Math.max(1, parseInt(concurrencyRaw, 10)) : 4;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return new Response(JSON.stringify({ error: "bad day" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* controller may already be closed if client aborted */
        }
      };

      try {
        const all = listOpenOrders(day);
        const total = limit ? Math.min(limit, all.length) : all.length;
        send({ type: "started", total, day });

        const brief = await runBuyPlanner({
          delivery_date: day,
          concurrency,
          limit,
          onItemDone: (decision, idx) => {
            send({ type: "item", decision, idx, total });
          },
        });

        send({ type: "done", brief });
      } catch (e) {
        send({ type: "error", message: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
