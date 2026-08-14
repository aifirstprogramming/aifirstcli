/**
 * `aifirst serve` — the book-mode endpoint.
 *
 * Speaks enough of the Anthropic Messages API for a client pointed at it with
 * ANTHROPIC_BASE_URL to work through the book. There is no model here: every reply
 * comes from `respond()`, which turns the reader's prompt back into the answer that
 * was computed and committed at authoring time.
 *
 * Three properties this must keep, because the whole point is that book mode is
 * free and private:
 *
 *   - **Loopback only.** Replies drive shell tool calls in the client, so a server
 *     reachable from the network is a way to run commands on this machine.
 *   - **No outbound request, ever.** Nothing here calls anything.
 *   - **No request bodies logged.** A client sends the reader's prompts and file
 *     contents; none of that is ours to write down.
 */

import { DEFAULT_PORT } from "../bookmode/port";
import type { MessagesRequest } from "../bookmode/responder";
import { respond } from "../bookmode/responder";
import { bodyReply, streamReply } from "../bookmode/sse";
import { resolveScope } from "../books";
import type { Args } from "../cli";
import { boolFlag, numberFlag } from "../cli";
import { resolveContent } from "../content";
import { read as readLog } from "../log/progress";
import { bold, cyan, dim, glyph, green, out } from "../output";

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}

/** The reader's book, so a Python reader is never handed Java. */
function readerLanguage(): string | undefined {
  const { content } = resolveContent();
  const scope = resolveScope(content, {});
  return scope.kind === "book" ? scope.book.language : undefined;
}

export interface BookServer {
  baseUrl: string;
  stop(): void;
}

export function startBookServer({ port = 0, quiet = false }: { port?: number; quiet?: boolean } = {}): BookServer {
  const server = Bun.serve({
    // Never 0.0.0.0. See the note at the top of this file.
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // The client health-checks before talking. Answering it keeps a failed
      // request out of the path on every start.
      if (url.pathname === "/api/hello") {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.pathname.endsWith("/count_tokens")) {
        // Honest, and it is what a reader is spending.
        return Response.json({ input_tokens: 0 });
      }

      if (!url.pathname.endsWith("/messages") || req.method !== "POST") {
        return new Response(JSON.stringify({ type: "error", error: { type: "not_found_error" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      let request: MessagesRequest;
      try {
        request = (await req.json()) as MessagesRequest;
      } catch {
        return new Response(
          JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "malformed JSON" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Read fresh each time: the reader may finish exercises while this runs, and
      // the closing message should tell them the truth about where they are.
      const { content } = resolveContent();
      const reply = respond(request, content, readLog(), { language: readerLanguage() });

      const ids = {
        messageId: id("msg"),
        toolUseId: id("toolu"),
        model: request.model ?? "aifirst-book-mode",
      };

      if (!quiet) {
        // The exercise id, or that it missed. Never the prompt: a reader's typed
        // text is not ours to print into a terminal that may be shared or logged.
        out(dim(`  ${reply.exerciseId ?? (reply.stopReason === "end_turn" ? "—" : "?")}  ${reply.stopReason}`));
      }

      if (request.stream) {
        return new Response(streamReply(reply, ids), {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      return Response.json(bodyReply(reply, ids));
    },
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;
  if (!quiet) {
    out();
    out(`  ${green(glyph.done)} book mode is serving on ${bold(baseUrl)}`);
    out(dim("  no model, no network — every answer comes from the content pack"));
    out();
    out(dim(`  ${cyan(glyph.arrow)} leave this running, and in another terminal:`));
    out(dim(`     aifirst book-mode on     point Claude Code at it`));
    out(dim(`     aifirst book-mode off    put it back`));
    out();
    out(dim("  Ctrl-C to stop."));
    out();
  }
  return { baseUrl, stop: () => server.stop(true) };
}

export function serve(args: Args): void {
  startBookServer({ port: numberFlag(args, "port") ?? DEFAULT_PORT, quiet: boolFlag(args, "quiet") });
}
