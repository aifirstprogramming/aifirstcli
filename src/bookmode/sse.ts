/**
 * Encode a reply as the Messages API event stream.
 *
 * The sequence is the documented public one — message_start, then a block of
 * content_block_start / delta / stop per content block, then message_delta and
 * message_stop. That contract is stable and public, which is the only reason
 * speaking it to a closed client is reasonable at all.
 *
 * The ordinary encoder emits one text delta. `aifirst learn` can instead use the
 * paced encoder so cached prose arrives gradually enough to read.
 */

import type { Reply } from "./responder";

export interface StreamIds {
  messageId: string;
  toolUseId: string;
  model: string;
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Zero, and true: no tokens were spent because no model ran. */
const USAGE = { input_tokens: 0, output_tokens: 0 };

function messageStart(ids: StreamIds): string {
  return event("message_start", {
    type: "message_start",
    message: {
      id: ids.messageId,
      type: "message",
      role: "assistant",
      model: ids.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: USAGE,
    },
  });
}

function textStart(): string {
  return event("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
}

function textDelta(text: string): string {
  return event("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
}

function afterText(reply: Reply, ids: StreamIds): string {
  const parts = [event("content_block_stop", { type: "content_block_stop", index: 0 })];
  if (reply.toolUse) {
    parts.push(
      event("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: reply.toolUse.id ?? ids.toolUseId, name: reply.toolUse.name, input: {} },
      }),
      event("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.toolUse.input) },
      }),
      event("content_block_stop", { type: "content_block_stop", index: 1 }),
    );
  }
  parts.push(
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: reply.stopReason, stop_sequence: null },
      usage: { output_tokens: 0 },
    }),
    event("message_stop", { type: "message_stop" }),
  );
  return parts.join("");
}

export function streamReply(reply: Reply, ids: StreamIds): string {
  const parts: string[] = [];

  parts.push(messageStart(ids), textStart(), textDelta(reply.text), afterText(reply, ids));

  return parts.join("");
}

export interface TextPacing {
  charsPerSecond: number;
  chunkChars?: number;
  /** Test seam; production uses Bun.sleep. */
  sleep?: (milliseconds: number) => Promise<unknown>;
}

function chunkText(text: string, limit: number): string[] {
  if (!text) return [""];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const slice = text.slice(start, end);
      const boundary = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\n"));
      if (boundary >= Math.floor(limit / 2)) end = start + boundary + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/** Stream cached text at a readable pace, then release any associated tool call. */
export function pacedStreamReply(reply: Reply, ids: StreamIds, pacing: TextPacing): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const rate = Math.max(1, pacing.charsPerSecond);
  const chunks = chunkText(reply.text, Math.max(4, pacing.chunkChars ?? 24));
  const sleep = pacing.sleep ?? Bun.sleep;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(messageStart(ids)));
        controller.enqueue(encoder.encode(textStart()));
        for (let index = 0; index < chunks.length; index++) {
          const chunk = chunks[index];
          const delay = Math.round((chunk.length / rate) * 1000);
          if (index > 0 && delay > 0) await sleep(delay);
          controller.enqueue(encoder.encode(textDelta(chunk)));
        }
        controller.enqueue(encoder.encode(afterText(reply, ids)));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/** The same reply as a plain response, for a client that did not ask to stream. */
export function bodyReply(reply: Reply, ids: StreamIds): Record<string, unknown> {
  const content: Record<string, unknown>[] = [{ type: "text", text: reply.text }];
  if (reply.toolUse) {
    content.push({
      type: "tool_use",
      id: reply.toolUse.id ?? ids.toolUseId,
      name: reply.toolUse.name,
      input: reply.toolUse.input,
    });
  }
  return {
    id: ids.messageId,
    type: "message",
    role: "assistant",
    model: ids.model,
    content,
    stop_reason: reply.stopReason,
    stop_sequence: null,
    usage: USAGE,
  };
}
