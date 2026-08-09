/**
 * Encode a reply as the Messages API event stream.
 *
 * The sequence is the documented public one — message_start, then a block of
 * content_block_start / delta / stop per content block, then message_delta and
 * message_stop. That contract is stable and public, which is the only reason
 * speaking it to a closed client is reasonable at all.
 *
 * Text is emitted as a single delta rather than word by word. There is nothing to
 * stream: the answer was written at authoring time and is already in memory.
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

export function streamReply(reply: Reply, ids: StreamIds): string {
  const parts: string[] = [];

  parts.push(
    event("message_start", {
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
    }),
  );

  parts.push(
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  );
  parts.push(
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: reply.text },
    }),
  );
  parts.push(event("content_block_stop", { type: "content_block_stop", index: 0 }));

  if (reply.toolUse) {
    parts.push(
      event("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: ids.toolUseId, name: reply.toolUse.name, input: {} },
      }),
    );
    // Tool input arrives as a JSON string built up across deltas; one delta
    // carrying the whole object is a valid degenerate case of that.
    parts.push(
      event("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.toolUse.input) },
      }),
    );
    parts.push(event("content_block_stop", { type: "content_block_stop", index: 1 }));
  }

  parts.push(
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: reply.stopReason, stop_sequence: null },
      usage: { output_tokens: 0 },
    }),
  );
  parts.push(event("message_stop", { type: "message_stop" }));

  return parts.join("");
}

/** The same reply as a plain response, for a client that did not ask to stream. */
export function bodyReply(reply: Reply, ids: StreamIds): Record<string, unknown> {
  const content: Record<string, unknown>[] = [{ type: "text", text: reply.text }];
  if (reply.toolUse) {
    content.push({
      type: "tool_use",
      id: ids.toolUseId,
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
