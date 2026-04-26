/**
 * Anthropic SDK wrapper.
 * - Single function: callTool() — runs one Opus 4.7 call with strict tool_use,
 *   extended thinking, and prompt caching on the system block.
 * - Returns the parsed tool input + cost metadata.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CallCost } from "./types.js";

const MODEL = "claude-opus-4-7";
const THINKING_BUDGET = 8000;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY not set in environment");
    }
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

// =============================================================================
// Content block helpers
// =============================================================================

export type UserContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | {
      type: "document";
      source: {
        type: "base64";
        media_type: "application/pdf";
        data: string;
      };
      cache_control?: { type: "ephemeral" };
    }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/png" | "image/jpeg";
        data: string;
      };
      cache_control?: { type: "ephemeral" };
    };

export function loadPdfAsDocumentBlock(
  pdfPath: string,
  options?: { cache?: boolean },
): UserContentBlock {
  const data = readFileSync(pdfPath).toString("base64");
  const block: UserContentBlock = {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data },
  };
  if (options?.cache) {
    block.cache_control = { type: "ephemeral" };
  }
  return block;
}

// =============================================================================
// callTool — the one shape every pipeline step uses
// =============================================================================

export interface CallToolOptions {
  /** Role label for logging / audit (e.g. "stage1_extract", "validator_a"). */
  role: string;
  /** System prompt text. Will be wrapped in a single cached system block. */
  systemPrompt: string;
  /** User message content blocks. */
  userContent: UserContentBlock[];
  /** The single tool to bind tool_choice to. */
  tool: Anthropic.Tool;
  /** Optional model override (default opus 4.7). */
  model?: string;
  /** Optional thinking budget override. */
  thinkingBudget?: number;
  /** Disable thinking for this call (e.g., very small calls). */
  disableThinking?: boolean;
  /** Cap on output tokens. Default 16k. */
  maxTokens?: number;
}

export interface CallToolResult<T = unknown> {
  role: string;
  promptHash: string;
  toolInput: T;
  cost: CallCost;
  startedAt: string;
  finishedAt: string;
  /** Full raw response for audit trail. */
  rawResponse: Anthropic.Message;
}

export async function callTool<T = unknown>(
  opts: CallToolOptions,
): Promise<CallToolResult<T>> {
  const client = getClient();
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  const promptHash = hashPrompt(opts.systemPrompt, opts.tool.name);

  const requestBody: Anthropic.MessageCreateParams = {
    model: opts.model ?? MODEL,
    max_tokens: opts.maxTokens ?? 16000,
    system: [
      {
        type: "text",
        text: opts.systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [opts.tool],
    tool_choice: { type: "tool", name: opts.tool.name },
    messages: [
      {
        role: "user",
        content: opts.userContent as Anthropic.MessageParam["content"],
      },
    ],
  };

  if (!opts.disableThinking) {
    requestBody.thinking = {
      type: "enabled",
      budget_tokens: opts.thinkingBudget ?? THINKING_BUDGET,
    };
  }

  const response = await client.messages.create(requestBody);
  const finishedAt = new Date().toISOString();
  const latencyMs = Math.round(performance.now() - t0);

  // Extract the tool_use block
  const toolUseBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUseBlock) {
    throw new Error(
      `[${opts.role}] Model did not return a tool_use block. Stop reason: ${response.stop_reason}`,
    );
  }

  const cost: CallCost = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
    latency_ms: latencyMs,
  };

  return {
    role: opts.role,
    promptHash,
    toolInput: toolUseBlock.input as T,
    cost,
    startedAt,
    finishedAt,
    rawResponse: response,
  };
}

function hashPrompt(systemPrompt: string, toolName: string): string {
  return createHash("sha256")
    .update(`${toolName}::${systemPrompt}`)
    .digest("hex")
    .slice(0, 16);
}

// =============================================================================
// Cost summary
// =============================================================================

export function sumCosts(costs: CallCost[]): CallCost {
  return costs.reduce(
    (acc, c) => ({
      input_tokens: acc.input_tokens + c.input_tokens,
      output_tokens: acc.output_tokens + c.output_tokens,
      cache_read_input_tokens: acc.cache_read_input_tokens + c.cache_read_input_tokens,
      cache_creation_input_tokens:
        acc.cache_creation_input_tokens + c.cache_creation_input_tokens,
      latency_ms: acc.latency_ms + c.latency_ms,
    }),
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      latency_ms: 0,
    },
  );
}
