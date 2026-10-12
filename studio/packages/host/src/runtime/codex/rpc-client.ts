import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { codex } from "@amo-studio/protocol";

// JSON-RPC client for `codex app-server` over WebSocket with a capability token. One instance = one connection;
// reconnecting is the caller's job (the server manager re-creates clients after a restart).

export type ClientMethod = codex.ClientRequest["method"];
export type ParamsOf<M extends ClientMethod> = Extract<codex.ClientRequest, { method: M }>["params"];
export type ServerNotification = codex.ServerNotification;
export type ServerRequest = codex.ServerRequest;

/** Responses for the methods the Host uses. Others resolve to `unknown`. */
export interface ResponseMap {
  initialize: codex.InitializeResponse;
  "thread/start": codex.v2.ThreadStartResponse;
  "thread/resume": codex.v2.ThreadResumeResponse;
  "thread/fork": codex.v2.ThreadForkResponse;
  "thread/archive": codex.v2.ThreadArchiveResponse;
  "thread/read": codex.v2.ThreadReadResponse;
  "thread/list": codex.v2.ThreadListResponse;
  "thread/loaded/list": codex.v2.ThreadLoadedListResponse;
  "thread/name/set": codex.v2.ThreadSetNameResponse;
  "turn/start": codex.v2.TurnStartResponse;
  "turn/steer": codex.v2.TurnSteerResponse;
  "turn/interrupt": codex.v2.TurnInterruptResponse;
}
export type ResponseOf<M extends ClientMethod> = M extends keyof ResponseMap ? ResponseMap[M] : unknown;

export class RpcError extends Error {
  constructor(readonly method: string, readonly code: number, message: string, readonly data?: unknown) {
    super(`${method}: ${message}`);
    this.name = "RpcError";
  }
}

export class ConnectionClosedError extends Error {
  constructor(method: string) {
    super(`${method}: connection closed`);
    this.name = "ConnectionClosedError";
  }
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export interface CodexRpcClientEvents {
  notification: [ServerNotification];
  /** A server request (approvals etc.). Answer with `respond(id, result)`; another client may answer first. */
  request: [ServerRequest];
  close: [];
}

export interface ConnectOptions {
  url: string;
  token: string;
  clientName?: string;
  clientVersion?: string;
  connectTimeoutMs?: number;
}

export class CodexRpcClient extends EventEmitter<CodexRpcClientEvents> {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  defaultTimeoutMs = 60_000;

  static async connect(options: ConnectOptions): Promise<CodexRpcClient> {
    const client = new CodexRpcClient();
    await client.open(options);
    return client;
  }

  get isOpen(): boolean {
    return !this.closed && this.ws?.readyState === WebSocket.OPEN;
  }

  private async open(options: ConnectOptions): Promise<void> {
    const ws = new WebSocket(options.url, { headers: { Authorization: `Bearer ${options.token}` }, handshakeTimeout: options.connectTimeoutMs ?? 5000 });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`app-server refused the connection: HTTP ${res.statusCode}`)));
    });
    ws.on("message", (data) => this.onMessage(String(data)));
    ws.on("close", () => this.onClose());
    ws.on("error", () => {
      // 'close' follows and does the cleanup.
    });
    await this.request("initialize", {
      clientInfo: { name: options.clientName ?? "amo-studio", title: "AMO Studio", version: options.clientVersion ?? "0.0.0" },
    } as ParamsOf<"initialize">);
    this.notify("initialized");
  }

  request<M extends ClientMethod>(method: M, params: ParamsOf<M>, options: { timeoutMs?: number } = {}): Promise<ResponseOf<M>> {
    if (!this.isOpen) return Promise.reject(new ConnectionClosedError(method));
    const id = this.nextId++;
    return new Promise<ResponseOf<M>>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(method, -32000, `timed out after ${timeoutMs} ms`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.isOpen) this.ws!.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  /** Answers a server request. */
  respond(id: codex.RequestId, result: unknown): void {
    if (this.isOpen) this.ws!.send(JSON.stringify({ id, result }));
  }

  close(): void {
    if (this.closed) return;
    this.ws?.close();
    this.onClose();
  }

  private onMessage(raw: string): void {
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(p.method, msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined && msg.method) {
      this.emit("request", msg as unknown as ServerRequest);
    } else if (msg.method) {
      this.emit("notification", msg as unknown as ServerNotification);
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new ConnectionClosedError(p.method));
      this.pending.delete(id);
    }
    this.emit("close");
  }
}
