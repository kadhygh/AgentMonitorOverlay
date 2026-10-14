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
  /** `localImage` inputs of the message that started the turn. */
  images: number;
  agentMessage(text: string, options?: { chunks?: number; delayMs?: number }): Promise<void>;
  /** Asks for approval and, when accepted, emits a completed commandExecution item with `output`. */
  command(command: string, options?: { output?: string; approval?: boolean }): Promise<ApprovalDecision | "auto">;
  /** Creates a subagent thread, reports it through a subAgentActivity item and runs `text` as its reply. */
  subAgent(text: string): Promise<FakeThread>;
  /** An MCP server asks before a tool runs (`mcpServer/elicitation/request`); resolves with the client's action. */
  mcpElicitation(message: string, serverName?: string): Promise<string>;
  /** An MCP server asks for a form (`requestedSchema` with properties); resolves with the client's whole response. */
  mcpForm(message: string, requestedSchema: Record<string, unknown>, serverName?: string): Promise<Record<string, unknown>>;
  /** request_user_input (`item/tool/requestUserInput`); resolves with the client's response ({ answers }). */
  requestUserInput(questions: Array<Record<string, unknown>>): Promise<Record<string, unknown>>;
  /** Emits a notification about this turn (`threadId` and `turnId` are filled in). */
  notify(method: string, params?: Record<string, unknown>): void;
  /** Emits item/started, then item/completed (with `done` merged in, e.g. a final status). */
  item(item: Record<string, unknown>, done?: Record<string, unknown>): void;
  sleep(ms: number): Promise<void>;
}

export type TurnScript = (ctx: TurnContext) => Promise<void>;

export class TurnInterrupted extends Error {}

/**
 * Default script, matching the mock model's directives:
 * `[[shell: cmd]]` approval + command, `[[slow]]` slow stream, `[[subagent]]` spawns a subagent, `[[fail]]` fails the turn,
 * `[[elicit]]` an MCP tool approval (replies `FAKE-ELICITED: <action>`), `[[ask]]` request_user_input with FAKE_QUESTIONS
 * (replies `FAKE-ANSWERS: <response JSON>`), `[[form]]` an MCP form with FAKE_FORM_SCHEMA (replies `FAKE-FORM: <response
 * JSON>`), `[[retry]]` two retried errors before the reply, `[[notices]]` the warnings Codex sends about a turn,
 * `[[items]]` the item types without a row of their own (image view and generation, hook prompt, collab call, sleep,
 * function output), `[[progress]]` an MCP call with progress and a command that is typed into, `[[ask-async]]`
 * request_user_input_async as Codex 0.162 sends it (an agentMessage with `delivery: "async"` and its questions; the turn
 * goes on and replies `FAKE-ASKED`), `[[bad-item]]` an item Studio cannot read before the reply, otherwise replies
 * `FAKE: <text>` (plus
 * ` [images: N]` when it carried images). Steered input
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
  if (ctx.userText.includes("[[ask-async]]")) {
    ctx.item({ type: "agentMessage", id: `call_${randomUUID()}`, text: "你最喜欢哪个季节？\n- 春天\n- 夏天\n- 秋天", phase: "final_answer", memoryCitation: null, delivery: "async", questions: [{ title: "你最喜欢哪个季节？", options: ["春天", "夏天", "秋天"] }] });
    await ctx.agentMessage("FAKE-ASKED");
    return;
  }
  if (ctx.userText.includes("[[bad-item]]")) {
    ctx.notify("item/completed", { item: null });
    await ctx.agentMessage("FAKE-AFTER-BAD");
    return;
  }
  if (ctx.userText.includes("[[ask]]")) {
    const response = await ctx.requestUserInput(FAKE_QUESTIONS);
    await ctx.agentMessage(`FAKE-ANSWERS: ${JSON.stringify(response)}`);
    return;
  }
  if (ctx.userText.includes("[[form]]")) {
    const response = await ctx.mcpForm("请填写发布信息", FAKE_FORM_SCHEMA);
    await ctx.agentMessage(`FAKE-FORM: ${JSON.stringify(response)}`);
    return;
  }
  if (ctx.userText.includes("[[retry]]")) {
    for (const n of [1, 2]) {
      ctx.notify("error", { error: { message: `Reconnecting... ${n}/5`, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: "stream disconnected before completion" }, willRetry: true });
      await ctx.sleep(80);
    }
    await ctx.agentMessage("FAKE-RETRIED");
    return;
  }
  if (ctx.userText.includes("[[notices]]")) {
    ctx.notify("model/rerouted", { fromModel: "gpt-5.5", toModel: "gpt-5.5-mini", reason: "highRiskCyberActivity" });
    ctx.notify("warning", { message: "Heads up: long threads can be less accurate." });
    ctx.notify("warning", { message: "Heads up: long threads can be less accurate." });
    ctx.notify("guardianWarning", { message: "The guardian blocked a risky command." });
    ctx.notify("mcpServer/startupStatus/updated", { name: "docs", status: "failed", error: "spawn docs-mcp ENOENT\nmore", failureReason: null });
    ctx.notify("hook/completed", { run: { eventName: "preToolUse", status: "blocked", statusMessage: "rm is not allowed", sourcePath: "C:\\hooks\\guard.ps1", entries: [] } });
    ctx.notify("hook/completed", { run: { eventName: "postToolUse", status: "completed", statusMessage: null, sourcePath: "C:\\hooks\\fmt.ps1", entries: [] } });
    await ctx.agentMessage("FAKE-NOTICED");
    return;
  }
  if (ctx.userText.includes("[[items]]")) {
    ctx.item({ type: "imageView", id: randomUUID(), path: "C:\\work\\shot.png" });
    ctx.item({ type: "imageGeneration", id: randomUUID(), status: "generating", revisedPrompt: "a red cube", result: "", failure: null }, { status: "completed", savedPath: "C:\\work\\cube.png" });
    ctx.item({ type: "hookPrompt", id: randomUUID(), fragments: [{ text: "Remember the style guide.", hookRunId: "h1" }] });
    ctx.item({ type: "collabAgentToolCall", id: randomUUID(), tool: "wait", status: "inProgress", senderThreadId: ctx.thread.id, receiverThreadIds: ["t-1", "t-2"], prompt: null, model: null, reasoningEffort: null, agentsStates: {} }, { status: "completed" });
    ctx.item({ type: "sleep", id: randomUUID(), durationMs: 3000 });
    ctx.item({ type: "functionCallOutput", id: randomUUID(), name: "lookup", namespace: "tools", output: "42" });
    await ctx.agentMessage("FAKE-ITEMS");
    return;
  }
  if (ctx.userText.includes("[[progress]]")) {
    const mcpId = randomUUID();
    ctx.notify("item/started", { item: { type: "mcpToolCall", id: mcpId, server: "docs", tool: "index", status: "inProgress", arguments: {}, result: null, error: null, durationMs: null } });
    ctx.notify("item/mcpToolCall/progress", { itemId: mcpId, message: "indexed 40 of 120 files" });
    const cmdId = randomUUID();
    ctx.notify("item/started", { item: { type: "commandExecution", id: cmdId, command: "python setup.py", cwd: ctx.thread.cwd, status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null } });
    ctx.notify("item/commandExecution/terminalInteraction", { itemId: cmdId, processId: "p1", stdin: "y\n" });
    ctx.notify("item/commandExecution/terminalInteraction", { itemId: cmdId, processId: "p1", stdin: "" });
    await ctx.agentMessage("FAKE-PROGRESS");
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
    await ctx.agentMessage(`FAKE: ${ctx.userText}${ctx.images ? ` [images: ${ctx.images}]` : ""}`);
  }
  if (ctx.turn.steered.length) await ctx.agentMessage(`FAKE-STEERED: ${ctx.turn.steered.join(" | ")}`);
};

/** Questions of `[[ask]]`: a choice with "other", and a secret. */
export const FAKE_QUESTIONS: Array<Record<string, unknown>> = [
  {
    id: "target",
    header: "目标环境",
    question: "要发布到哪个环境？",
    isOther: true,
    isSecret: false,
    options: [
      { label: "测试环境", description: "只影响内部测试" },
      { label: "正式环境", description: "所有玩家都会收到" },
    ],
  },
  { id: "token", header: "令牌", question: "发布令牌是什么？", isOther: false, isSecret: true, options: null },
];

/** The form of `[[form]]`: every field kind Studio shows. */
export const FAKE_FORM_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    version: { type: "string", title: "版本号", description: "例如 1.4.2", minLength: 1 },
    count: { type: "integer", title: "灰度人数", minimum: 1, maximum: 1000, default: 100 },
    notify: { type: "boolean", title: "通知玩家", default: true },
    channel: { type: "string", title: "渠道", oneOf: [{ const: "steam", title: "Steam" }, { const: "taptap", title: "TapTap" }] },
    regions: { type: "array", title: "地区", items: { anyOf: [{ const: "cn", title: "国服" }, { const: "global", title: "国际服" }] } },
  },
  required: ["version", "channel"],
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
  /** Called with the client's response (`{ decision }`, `{ action, content }`, `{ answers }`). */
  resolve: (result: Record<string, unknown>) => void;
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

  async function runTurn(thread: FakeThread, turn: FakeTurn, userText: string, images: number, turnScript: TurnScript) {
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
      images,
      sleep,
      notify(method, params = {}) {
        notify(thread.id, method, { threadId: thread.id, turnId: turn.id, ...params });
      },
      item(item, done = {}) {
        notify(thread.id, "item/started", { item, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() });
        const final = { ...item, ...done };
        turn.items.push(final);
        notify(thread.id, "item/completed", { item: final, threadId: thread.id, turnId: turn.id, completedAtMs: Date.now() });
      },
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
          pending.set(requestId, { requestId, threadId: thread.id, method: "mcpServer/elicitation/request", params, resolve: (r) => resolve(String(r.action ?? "decline")) });
          for (const c of subscribers(thread.id)) send(c, { id: requestId, method: "mcpServer/elicitation/request", params });
        });
        check();
        return action;
      },
      async mcpForm(message, requestedSchema, serverName = "amo") {
        check();
        const requestId = nextRequestId++;
        const params = { threadId: thread.id, turnId: turn.id, serverName, mode: "form", _meta: null, message, requestedSchema };
        const response = await new Promise<Record<string, unknown>>((resolve) => {
          pending.set(requestId, { requestId, threadId: thread.id, method: "mcpServer/elicitation/request", params, resolve });
          for (const c of subscribers(thread.id)) send(c, { id: requestId, method: "mcpServer/elicitation/request", params });
        });
        check();
        return response;
      },
      async requestUserInput(questions) {
        check();
        const requestId = nextRequestId++;
        const params = { threadId: thread.id, turnId: turn.id, itemId: randomUUID(), questions, isBlocking: true, autoResolutionMs: null };
        const response = await new Promise<Record<string, unknown>>((resolve) => {
          pending.set(requestId, { requestId, threadId: thread.id, method: "item/tool/requestUserInput", params, resolve });
          for (const c of subscribers(thread.id)) send(c, { id: requestId, method: "item/tool/requestUserInput", params });
        });
        check();
        return response;
      },
      async command(command, opts = {}) {
        check();
        const itemId = randomUUID();
        let decision: ApprovalDecision | "auto" = "auto";
        if (opts.approval !== false) {
          const requestId = nextRequestId++;
          const params = { threadId: thread.id, turnId: turn.id, itemId, command, cwd: thread.cwd, reason: null, startedAtMs: Date.now() };
          decision = await new Promise<ApprovalDecision>((resolve) => {
            pending.set(requestId, { requestId, threadId: thread.id, method: "item/commandExecution/requestApproval", params, resolve: (r) => resolve(String(r.decision ?? "decline") as ApprovalDecision) });
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

  const imagesOf = (input: unknown) => (Array.isArray(input) ? input.filter((i) => i && typeof i === "object" && (i as { type?: unknown }).type === "localImage").length : 0);

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
    // A ChatGPT login's quota: 5-hour and weekly windows.
    "account/rateLimits/read": () => ({
      ordinaryUsageAllowed: true,
      rateLimits: {
        limitId: "codex", limitName: null, normalModelSlug: null, credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null,
        primary: { usedPercent: 32, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
      },
      rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null,
    }),
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
      void runTurn(t, turn, userText, imagesOf(params.input), script);
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
    // Compaction runs as a turn of its own with a contextCompaction item, then a warning (as Codex 0.162 does).
    "thread/compact/start": (_client, params) => {
      const t = requireThread(params);
      if (t.activeTurn) throw rpcError(-32600, "a turn is already active");
      const turn: FakeTurn = { id: randomUUID(), status: "inProgress", items: [], steered: [], interrupted: false };
      t.turns.push(turn);
      t.activeTurn = turn;
      setTimeout(() => {
        notify(t.id, "turn/started", { threadId: t.id, turn: { ...turnView(turn), rootTurnId: turn.id } });
        const item = { type: "contextCompaction", id: randomUUID() };
        notify(t.id, "item/started", { item, threadId: t.id, turnId: turn.id, startedAtMs: Date.now() });
        notify(t.id, "thread/tokenUsage/updated", { threadId: t.id, turnId: turn.id, tokenUsage: { total: { totalTokens: 9000, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }, last: { totalTokens: 1781, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }, modelContextWindow: 200000 } });
        notify(t.id, "item/completed", { item, threadId: t.id, turnId: turn.id, completedAtMs: Date.now() });
        notify(t.id, "warning", { threadId: t.id, message: "Heads up: Long threads and multiple compactions can cause the model to be less accurate." });
        turn.status = "completed";
        t.activeTurn = null;
        notify(t.id, "turn/completed", { threadId: t.id, turn: turnView(turn) });
      }, 20);
      return {};
    },
    // Review mode, with Codex 0.162's turn ids: the items and turn/completed carry the review's id, turn/started
    // another one with the review's as rootTurnId; the review's own message streams and is never completed.
    "review/start": (_client, params) => {
      const t = requireThread(params);
      if (t.activeTurn) throw rpcError(-32600, "a turn is already active");
      const root: FakeTurn = { id: randomUUID(), status: "inProgress", items: [], steered: [], interrupted: false };
      t.turns.push(root);
      t.activeTurn = root;
      const target = params.target as { type: string; instructions?: string };
      const review = target.type === "custom" ? String(target.instructions) : "current changes";
      const findings = `FAKE-REVIEW: ${review}`;
      setTimeout(() => {
        const at = { threadId: t.id, turnId: root.id };
        const entered = { type: "enteredReviewMode", id: randomUUID(), review };
        notify(t.id, "item/started", { item: entered, ...at });
        notify(t.id, "item/completed", { item: entered, ...at });
        notify(t.id, "turn/started", { threadId: t.id, turn: { ...turnView({ ...root, id: randomUUID() }), rootTurnId: root.id } });
        const prompt = { type: "userMessage", id: randomUUID(), clientId: null, content: [{ type: "text", text: "Review the current code changes and provide prioritized findings.", text_elements: [] }] };
        notify(t.id, "item/started", { item: prompt, ...at });
        notify(t.id, "item/completed", { item: prompt, ...at });
        const raw = randomUUID();
        notify(t.id, "item/started", { item: { type: "agentMessage", id: raw, text: "" }, ...at });
        notify(t.id, "item/agentMessage/delta", { ...at, itemId: raw, delta: "{\"findings\":[]}" });
        const exited = { type: "exitedReviewMode", id: randomUUID(), review: findings };
        notify(t.id, "item/started", { item: exited, ...at });
        notify(t.id, "item/completed", { item: exited, ...at });
        const echo = { type: "agentMessage", id: randomUUID(), text: findings, phase: null };
        notify(t.id, "item/started", { item: { ...echo, text: "" }, ...at });
        notify(t.id, "item/completed", { item: echo, ...at });
        root.status = "completed";
        t.activeTurn = null;
        notify(t.id, "turn/completed", { threadId: t.id, turn: turnView(root) });
      }, 20);
      return { turn: turnView(root), reviewThreadId: t.id };
    },
    "skills/list": (_client, params) => ({
      data: ((params.cwds as string[] | undefined) ?? [process.cwd()]).map((cwd) => ({
        cwd,
        skills: [
          { name: "release-notes", description: "Write release notes from the changes", shortDescription: "写发布说明", path: `${cwd}\\.agents\\skills\\release-notes\\SKILL.md`, scope: "repo", enabled: true, pluginId: null },
          { name: "disabled-skill", description: "Off", path: `${cwd}\\.agents\\skills\\off\\SKILL.md`, scope: "repo", enabled: false, pluginId: null },
        ],
        errors: [],
      })),
    }),
    "turn/interrupt": (_client, params) => {
      const t = requireThread(params);
      if (t.activeTurn && t.activeTurn.id === params.turnId) t.activeTurn.interrupted = true;
      for (const [id, p] of pending) if (p.threadId === t.id) { pending.delete(id); p.resolve({ decision: "cancel", action: "cancel" }); }
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
        // Approvals answer with a decision, MCP elicitations with an action (and content), request_user_input with answers.
        p.resolve(msg.result);
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
