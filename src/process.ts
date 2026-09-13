export interface ProcessInput {
  write(value: string): void;
  end(): void;
}

export interface AsyncProcessOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  stdin?: "ignore" | "inherit" | string | Uint8Array | "interactive";
  timeoutMs?: number;
  signal?: AbortSignal;
  detached?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onInputReady?: (input: ProcessInput) => void;
}

export interface AsyncProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    output += text;
    if (text) onChunk?.(text);
  }
  const tail = decoder.decode();
  output += tail;
  if (tail) onChunk?.(tail);
  return output;
}

function stopProcess(proc: ReturnType<typeof Bun.spawn>): void {
  if (proc.exitCode !== null) return;
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return;
  }
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }
  setTimeout(() => {
    if (proc.exitCode !== null) return;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  }, 1_000).unref();
}

/** Run a child without blocking the renderer, while retaining exact captured output. */
export async function runAsyncProcess(
  argv: string[],
  options: AsyncProcessOptions,
): Promise<AsyncProcessResult> {
  const interactive = options.stdin === "interactive";
  const suppliedInput = typeof options.stdin === "string" && options.stdin !== "interactive"
    && options.stdin !== "ignore" && options.stdin !== "inherit"
    ? options.stdin
    : options.stdin instanceof Uint8Array
      ? options.stdin
      : undefined;
  const stdin = options.stdin === "inherit"
    ? "inherit"
    : interactive || suppliedInput !== undefined
      ? "pipe"
      : "ignore";
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdin,
      stdout: "pipe",
      stderr: "pipe",
      detached: options.detached ?? Boolean(
        process.platform !== "win32" && (options.signal || options.timeoutMs !== undefined),
      ),
    });
  } catch (error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: (error as Error).message,
      timedOut: false,
      aborted: false,
    };
  }

  const input = stdin === "pipe" ? proc.stdin : undefined;
  if (input && typeof input !== "number" && suppliedInput !== undefined) {
    try {
      input.write(suppliedInput);
      input.end();
    } catch {
      // A command may exit without reading its optional authored input.
    }
  } else if (input && typeof input !== "number" && interactive) {
    let ended = false;
    options.onInputReady?.({
      write(value: string) {
        if (ended || proc.exitCode !== null) return;
        try {
          input.write(value);
          input.flush();
        } catch {
          ended = true;
        }
      },
      end() {
        if (ended) return;
        ended = true;
        try {
          input.end();
        } catch {
          // The process may already have closed stdin while exiting.
        }
      },
    });
  }

  let timedOut = false;
  let aborted = false;
  const abort = () => {
    aborted = true;
    stopProcess(proc);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
        timedOut = true;
        stopProcess(proc);
      }, options.timeoutMs);

  const [stdout, stderr] = await Promise.all([
    readStream(proc.stdout as ReadableStream<Uint8Array>, options.onStdout),
    readStream(proc.stderr as ReadableStream<Uint8Array>, options.onStderr),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  options.signal?.removeEventListener("abort", abort);

  return {
    exitCode: timedOut ? 124 : proc.exitCode ?? 127,
    stdout,
    stderr,
    timedOut,
    aborted,
  };
}
