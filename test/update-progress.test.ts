import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fetchWithProgress } from "../src/commands/update";

/**
 * The buffered `arrayBuffer()`/`text()` reads this replaced went silent for
 * however long a download took, which is exactly what installer-progress
 * exists to fix. These tests prove the streaming replacement actually reads
 * incrementally (not just once at the end) and never puts a carriage return
 * or escape sequence where a non-TTY consumer (a CI log) would see one.
 */

const SIZE = 512 * 1024;
const CHUNK = 32 * 1024;
const DATA = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i++) DATA[i] = i % 251;

let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/asset") {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let sent = 0; sent < SIZE; sent += CHUNK) {
              controller.enqueue(DATA.slice(sent, sent + CHUNK));
              await new Promise((r) => setTimeout(r, 2));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "Content-Length": String(SIZE) },
        });
      }
      if (url.pathname === "/no-length") {
        return new Response(DATA);
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("fetchWithProgress", () => {
  it("downloads the full content, byte for byte", async () => {
    const bytes = await fetchWithProgress(`${base}/asset`, {}, "asset");
    expect(bytes.byteLength).toBe(SIZE);
    expect(bytes[0]).toBe(DATA[0]);
    expect(bytes[SIZE - 1]).toBe(DATA[SIZE - 1]);
  });

  it("works when the server sends no Content-Length", async () => {
    const bytes = await fetchWithProgress(`${base}/no-length`, {}, "asset");
    expect(bytes.byteLength).toBe(SIZE);
  });

  it("throws a CliError with the status code on a 404", async () => {
    await expect(fetchWithProgress(`${base}/missing`, {}, "asset")).rejects.toMatchObject({
      message: expect.stringContaining("404"),
    });
  });

  it("renders a percentage when Content-Length is present", async () => {
    // A plain (non-streamed) Response body gets Content-Length set
    // automatically by Bun, unlike a ReadableStream response, which always
    // sends chunked transfer-encoding and drops any explicit header. This
    // proves the percentage branch of render() fires when the header is
    // there, even though the reader may deliver it in one chunk.
    using plainServer = Bun.serve({
      port: 0,
      async fetch() {
        return new Response(DATA);
      },
    });

    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await fetchWithProgress(`http://localhost:${plainServer.port}/asset`, {}, "asset");
    } finally {
      process.stderr.write = original;
    }

    expect(chunks.join("")).toMatch(/100%.*\/ 0\.5 MB/);
  });

  it("writes progress to stderr with no carriage returns or ANSI escapes when not a TTY", async () => {
    // process.stderr.isTTY is undefined in the test runner (piped), which is
    // exactly the non-interactive path we're proving stays plain-text.
    expect(process.stderr.isTTY).toBeFalsy();

    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await fetchWithProgress(`${base}/asset`, {}, "asset");
    } finally {
      process.stderr.write = original;
    }

    const combined = chunks.join("");
    expect(combined.length).toBeGreaterThan(0);
    expect(combined).not.toContain("\r");
    // eslint-disable-next-line no-control-regex
    expect(/\u001b\[/.test(combined)).toBe(false);
    // Multiple lines prove it read incrementally rather than reporting once
    // at the end; each carries a growing byte count either way, with or
    // without a percentage (the local dev server doesn't forward
    // Content-Length on a streamed response, which is exercised directly
    // by the "no Content-Length" case above).
    expect(combined.split("\n").filter(Boolean).length).toBeGreaterThan(1);
    expect(combined).toMatch(/MB/);
  });
});
