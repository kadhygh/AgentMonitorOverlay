import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

// One ACP agent process (a DSH `--profile acp`): newline-delimited JSON-RPC 2.0 over stdio. Stdout carries only
// protocol frames; stderr goes to a log file. Requests from the agent (permission prompts) go to `onRequest`, whose
// result (or error) is the response; notifications (session/update) are emitted.

export interface AcpSpawn {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Where the process's stderr goes (appended). */
  logFile?: string;
}

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpError";
  }
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout | null;
}

export interface AcpEvents {
  notification: [method: string, params: unknown];
  exit: [code: number | null];
}

export class AcpConnection extends EventEmitter<AcpEvents> {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly log: WriteStream | null;
  private nextId = 1;
  private buffer = "";
  private exitCode: number | null | undefined = undefined;
  /** The end of stderr, for the error when the process exits. */
  private stderrTail = "";
  readonly exited: Promise<number | null>;

  constructor(
    spec: AcpSpawn,
    private readonly onRequest: (method: string, params: unknown) => Promise<unknown>,
  ) {
    super();
    this.child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    if (spec.logFile) {
      mkdirSync(dirname(spec.logFile), { recursive: true });
      this.log = createWriteStream(spec.logFile, { flags: "a" });
      this.log.on("error", () => undefined);
    } else {
      this.log = null;
    }
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.log?.write(chunk);
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2000);
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
    this.child.stdin.on("error", () => undefined);
    this.exited = new Promise((resolve) => {
      const done = (code: number | null) => {
        if (this.exitCode !== undefined) return;
        this.exitCode = code;
        const last = this.stderrTail.trim().split(/\r?\n/).slice(-8).join(" | ").slice(-800);
        const err = new AcpError(`DSH 进程已退出（${code ?? "被终止"}）${last ? `：${last}` : ""}`, -32000);
        for (const p of this.pending.values()) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        this.emit("exit", code);
        resolve(code);
      };
      this.child.on("exit", (code) => done(code));
      this.child.on("error", (err) => {
        this.log?.write(`spawn failed: ${String(err)}\n`);
        done(null);
      });
    });
  }

  get alive(): boolean {
    return this.exitCode === undefined;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** A request; `timeoutMs` 0 waits as long as it takes (a prompt runs until its turn ends). */
  request<T = unknown>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    if (!this.alive) return Promise.reject(new AcpError("DSH 进程已退出", -32000));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpError(`DSH 没有回应 ${method}（${Math.round(timeoutMs / 1000)} 秒）`, -32001));
      }, timeoutMs) : null;
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.alive) this.write({ jsonrpc: "2.0", method, params });
  }

  /** Ends the process: stdin closed (DSH drains and exits), then killed with its children if it lingers. */
  async close(graceMs = 10_000): Promise<void> {
    if (!this.alive) return;
    this.child.stdin.end();
    const code = await Promise.race([this.exited, new Promise<"late">((r) => setTimeout(() => r("late"), graceMs).unref())]);
    if (code === "late") this.kill();
    await this.exited;
    this.log?.end();
  }

  /** Kills the process tree at once (its shells included). */
  kill(): void {
    const pid = this.child.pid;
    if (!this.alive || !pid) return;
    if (process.platform === "win32") execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    else this.child.kill("SIGKILL");
  }

  private write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
      try {
        msg = JSON.parse(line);
      } catch {
        this.log?.write(`not JSON on stdout: ${line.slice(0, 200)}\n`);
        continue;
      }
      if (msg.method === undefined && msg.id !== undefined) {
        const p = this.pending.get(Number(msg.id));
        if (!p) continue;
        this.pending.delete(Number(msg.id));
        if (p.timer) clearTimeout(p.timer);
        if (msg.error) p.reject(new AcpError(msg.error.message, msg.error.code, msg.error.data));
        else p.resolve(msg.result);
      } else if (msg.method !== undefined && msg.id !== undefined) {
        const id = msg.id;
        this.onRequest(msg.method, msg.params).then(
          (result) => this.alive && this.write({ jsonrpc: "2.0", id, result }),
          (err: unknown) => this.alive && this.write({ jsonrpc: "2.0", id, error: { code: err instanceof AcpError ? err.code : -32603, message: String((err as Error)?.message ?? err) } }),
        );
      } else if (msg.method !== undefined) {
        this.emit("notification", msg.method, msg.params);
      }
    }
  }
}
