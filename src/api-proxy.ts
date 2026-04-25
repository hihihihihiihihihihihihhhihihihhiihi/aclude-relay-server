/**
 * API Proxy for intercepting Claude Code's Anthropic API traffic.
 *
 * When Claude Code runs with ANTHROPIC_BASE_URL=http://localhost:<port>,
 * all API calls route through this proxy. The proxy:
 * 1. Forwards requests to https://api.anthropic.com
 * 2. For SSE streaming responses, tees events and converts to ParsedChatEvent
 * 3. Calls a broadcast callback so events can be sent over WebSocket
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import type { Server } from "http";

// ---------------------------------------------------------------------------
// ParsedChatEvent types (mirrors stream-json-parser.ts)
// ---------------------------------------------------------------------------

export type ParsedChatEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; toolId: string; toolName: string; input: Record<string, unknown>; status: string }
  | { type: "tool_use_delta"; toolId: string; toolName: string; partialJson: string }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | { type: "thinking"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; costUsd: number; totalCostUsd: number; durationMs: number; sessionId: string }
  | { type: "session_meta"; model: string; thinkingBudget: number }
  | { type: "done"; numTurns: number }
  | { type: "error"; message: string }
  | { type: "status"; status: string };

// ---------------------------------------------------------------------------
// Options & interface
// ---------------------------------------------------------------------------

export interface ApiProxyOptions {
  port: number;
  onEvent: (event: ParsedChatEvent) => void;
  onUserMessage: (text: string) => void;
  onStreamStart: () => void;
  onStreamEnd: (info: { stopReason: string | null }) => void;
}

export interface ApiProxy {
  start(): Promise<number>;
  stop(): void;
}

// ---------------------------------------------------------------------------
// SSE parser state
// ---------------------------------------------------------------------------

interface StreamState {
  /** Current SSE event type from `event:` lines */
  currentEventType: string;
  /** Accumulated partial JSON for tool_use input_json_delta */
  toolInputAccumulators: Map<number, string>;
  /** Track content block types by index */
  blockTypes: Map<number, string>;
  /** Track tool_use metadata by block index */
  toolBlocks: Map<number, { id: string; name: string }>;
  /** Current content block index */
  currentBlockIndex: number;
  /** Usage from message_start (input tokens, cache) */
  startUsage: { inputTokens: number; cacheCreationTokens: number; cacheReadTokens: number } | null;
  /** Model from message_start */
  model: string | null;
  /** Timestamp when stream started */
  streamStartMs: number;
  /** stop_reason captured from message_delta (end_turn, tool_use, max_tokens, ...) */
  stopReason: string | null;
}

function createStreamState(): StreamState {
  return {
    currentEventType: "",
    toolInputAccumulators: new Map(),
    blockTypes: new Map(),
    toolBlocks: new Map(),
    currentBlockIndex: -1,
    startUsage: null,
    model: null,
    streamStartMs: Date.now(),
    stopReason: null,
  };
}

// ---------------------------------------------------------------------------
// User message extraction
// ---------------------------------------------------------------------------

function extractUserMessage(body: Buffer, onUserMessage: (text: string) => void): void {
  let parsed: { messages?: Array<{ role: string; content: unknown }> };
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    return;
  }

  if (!parsed.messages || !Array.isArray(parsed.messages)) return;

  // Walk backwards to find last user message
  for (let i = parsed.messages.length - 1; i >= 0; i--) {
    const msg = parsed.messages[i];
    if (msg.role !== "user") continue;

    // Extract text content
    const contents = Array.isArray(msg.content)
      ? msg.content
      : typeof msg.content === "string"
        ? [{ type: "text", text: msg.content }]
        : [];

    for (const block of contents) {
      if (typeof block === "string") {
        if (isCleanUserText(block)) {
          onUserMessage(block);
          return;
        }
        continue;
      }
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        if (isCleanUserText(block.text)) {
          onUserMessage(block.text);
          return;
        }
      }
    }
    break; // Only check the last user message
  }
}

function isCleanUserText(text: string): boolean {
  if (text.length > 5000) return false;
  if (text.includes("<system-reminder>") || text.includes("</system-reminder>")) return false;
  if (text.includes("MCP Server Instructions")) return false;
  if (text.startsWith("{") || text.startsWith("[")) return false;
  return text.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Tool result extraction
// ---------------------------------------------------------------------------

function extractToolResults(body: Buffer, onEvent: (event: ParsedChatEvent) => void): void {
  let parsed: { messages?: Array<{ role: string; content: unknown }> };
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    return;
  }

  if (!parsed.messages || !Array.isArray(parsed.messages)) return;

  for (const msg of parsed.messages) {
    if (msg.role !== "user") continue;
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (
        block &&
        typeof block === "object" &&
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        const content =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");
        onEvent({
          type: "tool_result",
          toolUseId: block.tool_use_id,
          content,
          isError: !!block.is_error,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Session metadata extraction (model, thinking budget)
// ---------------------------------------------------------------------------

function extractSessionMeta(body: Buffer, onEvent: (event: ParsedChatEvent) => void): void {
  let parsed: { model?: string; thinking?: { budget_tokens?: number; type?: string } };
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    return;
  }

  const model = parsed.model || "";
  const thinkingBudget = parsed.thinking?.budget_tokens ?? 0;

  if (model) {
    onEvent({
      type: "session_meta",
      model,
      thinkingBudget,
    });
  }
}

// ---------------------------------------------------------------------------
// SSE line parser
// ---------------------------------------------------------------------------

function processSSELine(
  line: string,
  state: StreamState,
  onEvent: (event: ParsedChatEvent) => void,
): void {
  if (line.startsWith("event: ")) {
    state.currentEventType = line.slice(7).trim();
    return;
  }

  if (!line.startsWith("data: ")) return;

  const dataStr = line.slice(6);
  if (dataStr === "[DONE]") return;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataStr);
  } catch {
    return;
  }

  const eventType = state.currentEventType || (data.type as string) || "";
  if (eventType === "message_start" || eventType === "message_delta" || eventType === "message_stop") {
    console.log(`[api-proxy] SSE event: ${eventType}`);
  }

  switch (eventType) {
    case "message_start": {
      state.streamStartMs = Date.now();
      onEvent({ type: "status", status: "streaming" });

      // Extract usage and model from message_start
      const msg = data.message as Record<string, unknown> | undefined;
      if (msg) {
        state.model = (msg.model as string) || null;
        const usage = msg.usage as Record<string, number> | undefined;
        if (usage) {
          state.startUsage = {
            inputTokens: usage.input_tokens || 0,
            cacheCreationTokens: usage.cache_creation_input_tokens || 0,
            cacheReadTokens: usage.cache_read_input_tokens || 0,
          };
        }
      }
      break;
    }

    case "content_block_start": {
      const idx = data.index as number;
      const contentBlock = data.content_block as Record<string, unknown> | undefined;
      if (contentBlock) {
        const blockType = contentBlock.type as string;
        state.blockTypes.set(idx, blockType);
        state.currentBlockIndex = idx;

        if (blockType === "tool_use") {
          state.toolBlocks.set(idx, {
            id: contentBlock.id as string,
            name: contentBlock.name as string,
          });
          state.toolInputAccumulators.set(idx, "");
          onEvent({
            type: "tool_use_start",
            toolId: contentBlock.id as string,
            toolName: contentBlock.name as string,
            input: {},
            status: "running",
          });
        }
      }
      break;
    }

    case "content_block_delta": {
      const idx = (data.index as number) ?? state.currentBlockIndex;
      const delta = data.delta as Record<string, unknown> | undefined;
      if (!delta) break;

      const deltaType = delta.type as string;

      if (deltaType === "text_delta") {
        onEvent({ type: "text_delta", text: delta.text as string });
      } else if (deltaType === "thinking_delta") {
        onEvent({ type: "thinking", text: delta.thinking as string });
      } else if (deltaType === "input_json_delta") {
        const partial = delta.partial_json as string;
        const accumulated = (state.toolInputAccumulators.get(idx) ?? "") + partial;
        state.toolInputAccumulators.set(idx, accumulated);
        // Forward streaming tool input to the client so the chat can render
        // Write/Edit content character-by-character as Anthropic emits it.
        const toolMeta = state.toolBlocks.get(idx);
        if (toolMeta) {
          onEvent({
            type: "tool_use_delta",
            toolId: toolMeta.id,
            toolName: toolMeta.name,
            partialJson: accumulated,
          });
        }
      }
      break;
    }

    case "content_block_stop": {
      const idx = (data.index as number) ?? state.currentBlockIndex;
      const blockType = state.blockTypes.get(idx);

      if (blockType === "tool_use") {
        const toolMeta = state.toolBlocks.get(idx);
        const accumulated = state.toolInputAccumulators.get(idx) ?? "";

        let parsedInput: Record<string, unknown> = {};
        if (accumulated) {
          try {
            parsedInput = JSON.parse(accumulated);
          } catch {
            // Partial JSON — emit what we have as a string
            parsedInput = { _raw: accumulated };
          }
        }

        if (toolMeta) {
          onEvent({
            type: "tool_use_start",
            toolId: toolMeta.id,
            toolName: toolMeta.name,
            input: parsedInput,
            status: "running",
          });
        }

        // Clean up
        state.toolInputAccumulators.delete(idx);
      }
      break;
    }

    case "message_delta": {
      // message_delta contains output_tokens in data.usage AND the final stop_reason.
      // Capturing stop_reason here lets the relay distinguish "Claude is done"
      // (end_turn / max_tokens) from "Claude is pausing for a tool call"
      // (tool_use → another stream starts right after).
      console.log("[api-proxy] message_delta received, usage:", JSON.stringify(data.usage));
      const deltaInfo = data.delta as { stop_reason?: string } | undefined;
      if (deltaInfo?.stop_reason) {
        state.stopReason = deltaInfo.stop_reason;
      }
      const deltaUsage = data.usage as Record<string, number> | undefined;
      if (deltaUsage) {
        const inputTokens = state.startUsage?.inputTokens ?? 0;
        const outputTokens = deltaUsage.output_tokens || 0;
        const cacheCreation = state.startUsage?.cacheCreationTokens ?? 0;
        const cacheRead = state.startUsage?.cacheReadTokens ?? 0;
        const durationMs = Date.now() - (state.streamStartMs || Date.now());

        // Sonnet 4.6 pricing: Input $3/MTok, Output $15/MTok
        // Cache read: $0.30/MTok, Cache creation: $3.75/MTok
        // input_tokens from message_start is non-cached input only
        const costUsd = (inputTokens * 3 + outputTokens * 15 + cacheRead * 0.30 + cacheCreation * 3.75) / 1_000_000;

        onEvent({
          type: "usage",
          inputTokens,
          outputTokens,
          cacheCreationTokens: cacheCreation,
          cacheReadTokens: cacheRead,
          costUsd,
          totalCostUsd: costUsd,
          durationMs,
          sessionId: "",
        });
      }
      break;
    }

    case "message_stop": {
      onEvent({ type: "done", numTurns: 1 });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Request body collector
// ---------------------------------------------------------------------------

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Proxy factory
// ---------------------------------------------------------------------------

const ANTHROPIC_BASE = "https://api.anthropic.com";
const MANAGED_PROXY_BASE =
  process.env.MANAGED_PROXY_URL ||
  "https://aclude-managed-proxy.aclude-proxy.workers.dev";

/**
 * Detect whether the incoming request is authenticated with an Aclude managed
 * proxy token (`apk_…`). If yes, the relay's local API proxy must forward the
 * request to the managed-proxy Cloudflare Worker instead of api.anthropic.com
 * — the worker is what enforces the user's monthly spend limit. Without this
 * routing, requests bypass the cap entirely.
 */
function detectManagedProxyToken(
  headers: Record<string, string>,
): string | null {
  for (const [key, value] of Object.entries(headers)) {
    const lk = key.toLowerCase();
    if (lk === "x-api-key" && value.startsWith("apk_")) return value;
    if (lk === "authorization" && value.startsWith("Bearer apk_")) {
      return value.slice("Bearer ".length);
    }
  }
  return null;
}

export function createApiProxy(options: ApiProxyOptions): ApiProxy {
  let server: Server | null = null;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    // Collect request body for POST/PUT/PATCH
    let body: Buffer | null = null;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      body = await collectBody(req);
    }

    // For /v1/messages POST, extract user messages and tool results
    if (url.startsWith("/v1/messages") && method === "POST" && body) {
      const bodyLen = body.length;
      console.log(`[api-proxy] POST /v1/messages (${bodyLen} bytes)`);

      extractUserMessage(body, options.onUserMessage);
      extractToolResults(body, options.onEvent);
      extractSessionMeta(body, options.onEvent);
    }

    // Build upstream headers — strip accept-encoding to avoid gzip
    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!value) continue;
      const lk = key.toLowerCase();
      if (lk === "accept-encoding") continue;
      if (lk === "host") continue;
      forwardHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
    }

    // Decide upstream: managed-proxy worker if the caller is using an `apk_`
    // token, otherwise direct to Anthropic. The token-based detection means
    // every request is independently routed — no per-session config needed.
    const managedToken = detectManagedProxyToken(forwardHeaders);
    const upstreamBase = managedToken ? MANAGED_PROXY_BASE : ANTHROPIC_BASE;
    if (managedToken) {
      // Worker expects Authorization: Bearer apk_… and ignores Anthropic-only
      // headers. Strip x-api-key + anthropic-beta so the worker's own headers
      // (which it sets when forwarding to Anthropic) don't collide.
      forwardHeaders["Authorization"] = `Bearer ${managedToken}`;
      delete forwardHeaders["authorization"]; // older lower-case duplicate
      delete forwardHeaders["x-api-key"];
      delete forwardHeaders["X-Api-Key"];
      delete forwardHeaders["anthropic-beta"];
      delete forwardHeaders["anthropic-version"];
      console.log(`[api-proxy] Routing via managed proxy (apk_…${managedToken.slice(-6)})`);
    }
    const upstreamUrl = `${upstreamBase}${url}`;
    let upstreamRes: Response;
    try {
      const fetchInit: RequestInit = {
        method,
        headers: forwardHeaders,
      };
      if (body) {
        fetchInit.body = new Uint8Array(body);
      }
      upstreamRes = await fetch(upstreamUrl, fetchInit);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[api-proxy] Upstream error: ${message}`);
      options.onEvent({ type: "error", message: `Upstream error: ${message}` });
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "proxy_error", message } }));
      return;
    }

    // Build response headers — strip content-encoding
    const responseHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((value, key) => {
      const lk = key.toLowerCase();
      if (lk === "content-encoding") return;
      if (lk === "transfer-encoding") return;
      responseHeaders[key] = value;
    });

    res.writeHead(upstreamRes.status, responseHeaders);

    // Check if this is an SSE stream
    const contentType = upstreamRes.headers.get("content-type") ?? "";
    const isSSE = contentType.includes("text/event-stream");
    console.log(`[api-proxy] Response status=${upstreamRes.status}, content-type="${contentType}", isSSE=${isSSE}, hasBody=${!!upstreamRes.body}`);

    if (!isSSE || !upstreamRes.body) {
      // Non-streaming response — pipe through and extract usage from JSON
      const respBody = Buffer.from(await upstreamRes.arrayBuffer());
      res.end(respBody);

      // Parse JSON response for usage data (Claude Code often uses stream:false)
      if (contentType.includes("application/json") && respBody.length > 0) {
        try {
          const json = JSON.parse(respBody.toString("utf-8"));
          if (json.usage) {
            const inputTokens = json.usage.input_tokens || 0;
            const outputTokens = json.usage.output_tokens || 0;
            const cacheCreation = json.usage.cache_creation_input_tokens || 0;
            const cacheRead = json.usage.cache_read_input_tokens || 0;
            const costUsd = (inputTokens * 3 + outputTokens * 15 + cacheRead * 0.30 + cacheCreation * 3.75) / 1_000_000;
            console.log(`[api-proxy] JSON usage: in=${inputTokens} out=${outputTokens} cost=$${costUsd.toFixed(4)}`);
            options.onEvent({
              type: "usage",
              inputTokens,
              outputTokens,
              cacheCreationTokens: cacheCreation,
              cacheReadTokens: cacheRead,
              costUsd,
              totalCostUsd: costUsd,
              durationMs: 0,
              sessionId: "",
            });
          }
          if (json.model) {
            options.onEvent({
              type: "session_meta",
              model: json.model,
              thinkingBudget: 0,
            });
          }
        } catch {}
      }
      return;
    }

    // SSE streaming — tee the stream
    console.log("[api-proxy] SSE stream started");
    options.onStreamStart();

    const state = createStreamState();
    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let partial = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Forward raw bytes to Claude Code
        const chunk = value instanceof Uint8Array ? Buffer.from(value) : value;
        res.write(chunk);

        // Parse SSE lines
        partial += decoder.decode(chunk, { stream: true });
        const lines = partial.split("\n");
        // Keep the last potentially incomplete line
        partial = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          processSSELine(trimmed, state, options.onEvent);
        }
      }

      // Process any remaining partial line
      if (partial.trim().length > 0) {
        processSSELine(partial.trim(), state, options.onEvent);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[api-proxy] Stream error: ${message}`);
      options.onEvent({ type: "error", message: `Stream error: ${message}` });
    } finally {
      res.end();
      console.log(`[api-proxy] SSE stream ended (stop_reason: ${state.stopReason})`);
      options.onStreamEnd({ stopReason: state.stopReason });
    }
  };

  return {
    async start(): Promise<number> {
      return new Promise((resolve, reject) => {
        server = createServer((req, res) => {
          handler(req, res).catch((err) => {
            console.error("[api-proxy] Unhandled error:", err);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: { type: "internal_error", message: "Proxy error" } }));
            }
          });
        });

        server.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE" && options.port !== 0) {
            // Retry on port 0 (auto-assign)
            console.log(`[api-proxy] Port ${options.port} in use, trying auto-assign`);
            server!.listen(0, "127.0.0.1", () => {
              const addr = server!.address();
              const actualPort = typeof addr === "object" && addr ? addr.port : 0;
              console.log(`[api-proxy] Listening on 127.0.0.1:${actualPort}`);
              resolve(actualPort);
            });
          } else {
            reject(err);
          }
        });

        server.listen(options.port, "127.0.0.1", () => {
          const addr = server!.address();
          const actualPort = typeof addr === "object" && addr ? addr.port : options.port;
          console.log(`[api-proxy] Listening on 127.0.0.1:${actualPort}`);
          resolve(actualPort);
        });
      });
    },

    stop(): void {
      if (server) {
        server.close();
        server = null;
        console.log("[api-proxy] Stopped");
      }
    },
  };
}
