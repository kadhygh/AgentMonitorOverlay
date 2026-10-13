import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { listenInStudioRange } from "./ports.js";

// Scripted stand-in for `codex app-server` over WebSocket. It implements the JSON-RPC subset the Host uses and mirrors
// the behaviour measured in studio/spikes/RESULTS.md:
// - notifications go to every client subscribed to the thread (thread/start or thread/resume subscribes);
// - approval requests are broadcast, the first answer wins, then `serverRequest/resolved` is broadcast;
// - a client that subscribes while an approval is pending receives that request too;
// - `thread/started` for a fork reaches subscribers of the parent; forks take the server default provider unless
//   `modelProvider` is passed;
// - a thread without turns cannot be resumed by another client ("no rollout found");
// - subagents are announced only by a subAgentActivity item on the parent (no thread/started).

export interface FakeThread {
  id: string;
  forkedFromId: string | null;
  parentThreadId: string | null;
  modelProvider: string;
  model: string;
  cwd: string;
  archived: boolean;
  turns: FakeTurn[];
  activeTurn: FakeTurn | null;
}

export interface FakeTurn {
  id: string;
  status: "inProgress" | "completed" | "interrupted" | "failed";
  items: Array<Record<string, unknown>>;
  /** User input steered into the running turn. */
  steered: string[];
  interrupted: boolean;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

/** Helpers a turn script uses to emit items. Every helper respects interruption by throwing `TurnInterrupted`. */
export interface TurnContext {
  thread: FakeThread;
  turn: FakeTurn;
  userText: string;
  agentMessage(text: string, options?: { chunks?: number; delayMs?: number }): Promise<void>;
  /** Asks for approval and, when accepted, emits a completed commandExecution item with `output`. */
  command(command: string, options?: { output?: string; approval?: boolean }): Promise<ApprovalDecision | "auto">;
  /** Creates a subagent thread, reports it through a subAgentActivity item and runs `text` as its reply. */
  subAgent(text: string): Promise<FakeThread>;
  /** An MCP server asks before a tool runs (`mcpServer/elicitation/request`); resolves with the client's action. */
  mcpElicitation(message: string, serverName?: string): Promise<string>;
  sleep(ms: number): Promise<void>;
}

export type TurnScript = (ctx: TurnContext) => Promise<void>;

export class TurnInterrupted extends Error {}

/**
 * Default script, matching the mock model's directives:
 * `[[shell: cmd]]` approval + command, `[[slow]]` slow stream, `[[subagent]]` spawns a subagent, `[[fail]]` fails the turn,
 * `[[elicit]]` an MCP tool approval (replies `FAKE-ELICITED: <action>`), otherwise replies `FAKE: <text>`. Steered input
 * is acknowledged in the reply.
 */
export const defaultTurnScript: TurnScript = async (ctx) => {
  const shell = /\[\[shell:\s*([^\]]+)\]\]/.exec(ctx.userText);
  if (shell) {
    const decision = await ctx.command(shell[1]!.trim(), { output: "fake-output" });
    await ctx.agentMessage(decision === "accept" || decision === "acceptForSession" ? "FAKE-RAN" : "FAKE-DENIED");
    return;
  }
  if (ctx.userText.includes("[[fail]]")) throw new Error("scripted failure");
  if (ctx.userText.includes("[[elicit]]")) {
    const action = await ctx.mcpElicitation('Allow the amo MCP server to run tool "canvas_group_create"?');
    await ctx.agentMessage(`FAKE-ELICITED: ${action}`);
    return;
  }
  if (ctx.userText.includes("[[subagent]]")) {
    await ctx.subAgent("FAKE-SUB-DONE");
    await ctx.agentMessage("FAKE: subagent finished");
    return;
  }
  if (ctx.userText.includes("[[slow]]")) {
    await ctx.agentMessage("slow ".repeat(30).trim(), { chunks: 30, delayMs: 100 });
  } else {
    await ctx.agentMessage(`FAKE: ${ctx.userText}`);
  }
  if (ctx.turn.steered.length) await ctx.agentMessage(`FAKE-STEERED: ${ctx.turn.steered.join(" | ")}`);
};

interface Client {
  ws: WebSocket;
  initialized: boolean;
  subscriptions: Set<string>;
}

interface PendingApproval {
  requestId: number;
  threadId: string;
  method: string;
  params: Record<string, unknown>;
  resolve: (decision: string) => void;
}

export interface FakeAppServerOptions {
  port?: number;
  token?: string;
  defaultProvider?: string;
  defaultModel?: string;
  script?: TurnScript;
}

export interface FakeAppServer {
  url: string;
  port: number;
  token: string;
  threads: Map<string, FakeThread>;
  /** Every JSON-RPC request received, for assertions. */
  calls: Array<{ method: string; params: unknown }>;
  close(): Promise<void>;
}

const nowSec = () => Math.floor(Date.now() / 1000);

export async function startFakeAppServer(options: FakeAppServerOptions = {}): Promise<FakeAppServer> {
  const token = options.token ?? randomUUID();
  const defaultProvider = options.defaultProvider ?? "openai";
  const defaultModel = options.defaultModel ?? "fake-model";
  const script = options.script ?? defaultTurnScript;
  const threads = new Map<string, FakeThread>();
  const clients = new Set<Client>();
  const pending = new Map<number, PendingApproval>();
  const calls: FakeAppServer["calls"] = [];
  let nextRequestId = 0;

  // An HTTP server carries the WebSocket server so it can listen inside Studio's port range (red line 6). The
  // WebSocket server is attached only once listening succeeded: it re-emits the HTTP server's errors, which would turn
  // a port already in use (retried by listenInStudioRange) into an unhandled error.
  const http = createHttpServer();
  if (options.port) await new Promise<void>((resolve) => http.listen(options.port, "127.0.0.1", resolve));
  else await listenInStudioRange(http);
  const wss = new WebSocketServer({
    server: http,
    verifyClient: (info: { req: { headers: Record<string, string | string[] | undefined> } }) => info.req.headers.authorization === `Bearer ${token}`,
  });
  const port = (http.address() as AddressInfo).port;

  const send = (client: Client, msg: unknown) => {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
  };
  const subscribers = (threadId: string) => [...clients].filter((c) => c.subscriptions.has(threadId));
  const notify = (threadId: string, method: string, params: Record<string, unknown>, extra: Client[] = []) => {
    const targets = new Set([...subscribers(threadId), ...extra]);
    for (const c of targets) send(c, { method, params });
  };

  const threadView = (t: FakeThread, withTurns = true) => ({
    id: t.id,
    sessionId: t.parentThreadId ?? t.forkedFromId ?? t.id,
    forkedFromId: t.forkedFromId,
    parentThreadId: t.parentThreadId,
    preview: "",
    ephemeral: false,
    modelProvider: t.modelProvider,
    model: t.model,
    cwd: t.cwd,
    status: t.activeTurn ? { type: "active", activeFlags: [] } : { type: "idle" },
    turns: withTurns ? t.turns.map(turnView) : [],
  });
  const turnView = (turn: FakeTurn) => ({
    id: turn.id,
    items: turn.items,
    itemsView: "full",
    status: turn.status,
    error: turn.status === "failed" ? { message: "scripted failure" } : null,
    startedAt: nowSec(),
    completedAt: turn.status === "inProgress" ? null : nowSec(),
    durationMs: null,
  });

  const newThread = (params: Record<string, unknown>, extra: Partial<FakeThread> = {}): FakeThread => {
    const t: FakeThread = {
      id: randomUUID(),
      forkedFromId: null,
      parentThreadId: null,
      modelProvider: (params.modelProvider as string | undefined) ?? defaultProvider,
      model: (params.model as string | undefined) ?? defaultModel,
      cwd: (params.cwd as string | undefined) ?? process.cwd(),
      archived: false,
      turns: [],
      activeTurn: null,
      ...extra,
    };
    threads.set(t.id, t);
    return t;
  };

  const threadResponse = (t: FakeThread) => ({
    thread: threadView(t),
    model: t.model,
    modelProvider: t.modelProvider,
    cwd: t.cwd,
    approvalPolicy: "on-request",
  });

  function emitItem(thread: FakeThread, turn: FakeTurn, item: Record<string, unknown>) {
    notify(thread.id, "item/started", { item: { ...item, status: item.type === "commandExecution" ? "inProgress" : item.status }, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() });
    turn.items.push(item);
    notify(thread.id, "item/completed", { item, threadId: thread.id, turnId: turn.id, completedAtMs: Date.now() });
  }

  async function runTurn(thread: FakeThread, turn: FakeTurn, userText: string, turnScript: TurnScript) {
    const check = () => {
      if (turn.interrupted) throw new TurnInterrupted();
    };
    const sleep = async (ms: number) => {
      const step = 20;
      for (let waited = 0; waited < ms; waited += step) {
        check();
        await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
      }
      check();
    };
    const ctx: TurnContext = {
      thread,
      turn,
      userText,
      sleep,
      async agentMessage(text, opts = {}) {
        check();
        const itemId = randomUUID();
        const chunks = Math.max(1, opts.chunks ?? 2);
        const size = Math.ceil(text.length / chunks) || 1;
        notify(thread.id, "item/started", { item: { type: "agentMessage", id: itemId, text: "" }, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() });
        for (let i = 0; i < text.length; i += size) {
          notify(thread.id, "item/agentMessage/delta", { threadId: thread.id, turnId: turn.id, itemId, delta: text.slice(i, i + size) });
          if (opts.delayMs) await sleep(opts.delayMs);
          check();
        }
        const item = { type: "agentMessage", id: itemId, text, phase: null };
        turn.items.push(item);
        notify(thread.id, "item/completed", { item, threadId: thread.id, turnId: turn.id, completedAtMs: Date.now() });
      },
      async mcpElicitation(message, serverName = "amo") {
        check();
        const requestId = nextRequestId++;
        const params = { threadId: thread.id, turnId: turn.id, serverName, mode: "form", _meta: null, message, requestedSchema: { type: "object", properties: {} } };
        const action = await new Promise<string>((resolve) => {
          pending.set(requestId, { requestId, threadId: thread.id, method: "mcpServer/elicitation/request", params, resolve });
          for (const c of subscribers(thread.id)) send(c, { id: requestId, method: "mcpServer/elicitation/request", params });
        });
        check();
        return action;
      },
      async command(command, opts = {}) {
        check();
        const itemId = randomUUID();
        let decision: ApprovalDecision | "auto" = "auto";
        if (opts.approval !== false) {
          const requestId = nextRequestId++;
          const params = { threadId: thread.id, turnId: turn.id, itemId, command, cwd: thread.cwd, reason: null, startedAtMs: Date.now() };
          decision = await new Promise<ApprovalDecision>((resolve) => {
            pending.set(requestId, { requestId, threadId: thread.id, method: "item/commandExecution/requestApproval", params, resolve: (d) => resolve(d as ApprovalDecision) });
            for (const c of subscribers(thread.id)) send(c, { id: requestId, method: "item/commandExecution/requestApproval", params });
          });
          check();
        }
        const ran = decision === "auto" || decision === "accept" || decision === "acceptForSession";
        emitItem(thread, turn, {
          type: "commandExecution",
          id: itemId,
          command,
          cwd: thread.cwd,
          status: ran ? "completed" : "declined",
          aggregatedOutput: ran ? (opts.output ?? "") : "exec command rejected by user",
          exitCode: ran ? 0 : null,
        });
        return decision;
      },
      async subAgent(text) {
        check();
        const child = newThread({ modelProvider: thread.modelProvider, model: thread.model, cwd: thread.cwd }, { parentThreadId: thread.id });
        // Like Codex 0.161: no thread/started for subagents, only the subAgentActivity item on the parent.
        emitItem(thread, turn, { type: "subAgentActivity", id: randomUUID(), kind: "started", agentThreadId: child.id, agentPath: "explorer" });
        for (const c of subscribers(thread.id)) c.subscriptions.add(child.id);
        const childTurn: FakeTurn = { id: randomUUID(), status: "inProgress", items: [], steered: [], interrupted: false };
        child.turns.push(childTurn);
        notify(child.id, "turn/started", { threadId: child.id, turn: turnView(childTurn) });
        const item = { type: "agentMessage", id: randomUUID(), text, phase: null };
        emitItem(child, childTurn, item);
        childTurn.status = "completed";
        notify(child.id, "turn/completed", { threadId: child.id, turn: turnView(childTurn) });
        emitItem(thread, turn, { type: "subAgentActivity", id: randomUUID(), kind: "completed", agentThreadId: child.id, agentPath: "explorer" });
        return child;
      },
    };
    try {
      await turnScript(ctx);
      turn.status = "completed";
    } catch (err) {
      turn.status = err instanceof TurnInterrupted ? "interrupted" : "failed";
      // Interrupting cancels any approval still waiting for this turn.
      for (const [id, p] of pending) {
        if (p.threadId !== thread.id) continue;
        pending.delete(id);
        notify(thread.id, "serverRequest/resolved", { threadId: thread.id, requestId: id });
      }
    }
    thread.activeTurn = null;
    notify(thread.id, "turn/completed", { threadId: thread.id, turn: turnView(turn) });
    notify(thread.id, "thread/status/changed", { threadId: thread.id, status: { type: "idle" } });
  }

  const textOf = (input: unknown) =>
    Array.isArray(input) ? input.map((i) => (i && typeof i === "object" && "text" in i ? String((i as { text: unknown }).text) : "")).join("") : "";

  type Handler = (client: Client, params: Record<string, unknown>) => unknown;
  const requireThread = (params: Record<string, unknown>) => {
    const t = threads.get(String(params.threadId));
    if (!t) throw rpcError(-32600, `thread not found: ${String(params.threadId)}`);
    return t;
  };

  const handlers: Record<string, Handler> = {
    initialize: (client) => {
      client.initialized = true;
      return { userAgent: "fake-app-server/0.0.0" };
    },
    "thread/start": (client, params) => {
      const t = newThread(params);
      client.subscriptions.add(t.id);
      notify(t.id, "thread/started", { thread: threadView(t) });
      return threadResponse(t);
    },
    "thread/resume": (client, params) => {
      const t = requireThread(params);
      if (!t.turns.length) throw rpcError(-32600, `no rollout found for thread id ${t.id}`);
      client.subscriptions.add(t.id);
      // Late subscribers receive approvals that are still pending.
      for (const p of pending.values()) if (p.threadId === t.id) send(client, { id: p.requestId, method: p.method, params: p.params });
      return threadResponse(t);
    },
    "thread/fork": (client, params) => {
      const parent = requireThread(params);
      const t = newThread({ ...params, cwd: parent.cwd }, { forkedFromId: parent.id });
      t.turns = parent.turns.map((turn) => ({ ...turn, items: [...turn.items] }));
      client.subscriptions.add(t.id);
      notify(parent.id, "thread/started", { thread: threadView(t) }, [client]);
      return threadResponse(t);
    },
    "thread/name/set": (_client, params) => {
      const t = requireThread(params);
      notify(t.id, "thread/name/updated", { threadId: t.id, threadName: params.name });
      return {};
    },
    "thread/archive": (_client, params) => {
      const t = requireThread(params);
      t.archived = true;
      notify(t.id, "thread/archived", { threadId: t.id });
      return {};
    },
    "thread/unarchive": (_client, params) => {
      const t = requireThread(params);
      t.archived = false;
      notify(t.id, "thread/unarchived", { threadId: t.id });
      return { thread: threadView(t) };
    },
    "thread/read": (_client, params) => ({ thread: threadView(requireThread(params), params.includeTurns !== false) }),
    "thread/list": (_client, params) => {
      const providers = (params.modelProviders as string[] | undefined) ?? [defaultProvider];
      const data = [...threads.values()]
        // Codex 0.161 lists forks (0.144 did not); subagent threads stay out of the list.
        .filter((t) => !t.archived && !t.parentThreadId && providers.includes(t.modelProvider))
        .map((t) => threadView(t, false));
      return { data, nextCursor: null };
    },
    "thread/loaded/list": () => ({ data: [...threads.values()].filter((t) => !t.archived).map((t) => t.id), nextCursor: null }),
    "turn/start": (_client, params) => {
      const t = requireThread(params);
      if (t.activeTurn) throw rpcError(-32600, "a turn is already active");
      const userText = textOf(params.input);
      const turn: FakeTurn = { id: randomUUID(), status: "inProgress", items: [], steered: [], interrupted: false };
      t.turns.push(turn);
      t.activeTurn = turn;
      notify(t.id, "thread/status/changed", { threadId: t.id, status: { type: "active", activeFlags: [] } });
      notify(t.id, "turn/started", { threadId: t.id, turn: turnView(turn) });
      emitItem(t, turn, { type: "userMessage", id: randomUUID(), clientId: null, content: params.input });
      void runTurn(t, turn, userText, script);
      return { turn: turnView(turn) };
    },
    "turn/steer": (_client, params) => {
      const t = requireThread(params);
      if (!t.activeTurn || t.activeTurn.id !== params.expectedTurnId) throw rpcError(-32600, "expectedTurnId does not match the active turn");
      const text = textOf(params.input);
      t.activeTurn.steered.push(text);
      emitItem(t, t.activeTurn, { type: "userMessage", id: randomUUID(), clientId: null, content: params.input });
      return { turnId: t.activeTurn.id };
    },
    "turn/interrupt": (_client, params) => {
      const t = requireThread(params);
      if (t.activeTurn && t.activeTurn.id === params.turnId) t.activeTurn.interrupted = true;
      for (const [id, p] of pending) if (p.threadId === t.id) { pending.delete(id); p.resolve("cancel"); }
      return {};
    },
  };

  wss.on("connection", (ws) => {
    const client: Client = { ws, initialized: false, subscriptions: new Set() };
    clients.add(client);
    ws.on("close", () => clients.delete(client));
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: { decision?: ApprovalDecision; action?: string } };
      if (msg.method && msg.id !== undefined) {
        calls.push({ method: msg.method, params: msg.params });
        const handler = handlers[msg.method];
        if (!handler) return send(client, { id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
        if (!client.initialized && msg.method !== "initialize") return send(client, { id: msg.id, error: { code: -32002, message: "not initialized" } });
        try {
          send(client, { id: msg.id, result: handler(client, msg.params ?? {}) });
        } catch (err) {
          const e = err as { code?: number; message: string };
          send(client, { id: msg.id, error: { code: e.code ?? -32603, message: e.message } });
        }
      } else if (msg.id !== undefined && msg.result) {
        // Answer to a server request: first answer wins.
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        notify(p.threadId, "serverRequest/resolved", { threadId: p.threadId, requestId: msg.id });
        // Command approvals answer with a decision, MCP elicitations with an action.
        p.resolve(msg.result.decision ?? msg.result.action ?? "decline");
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    token,
    threads,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.ws.terminate();
        wss.close(() => http.close(() => resolve()));
      }),
  };
}

function rpcError(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}
