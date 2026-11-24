import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inTurn, type AccountUsage, type AgyCheck, type ApprovalDecision, type Attachment, type Id, type McpApply, type McpServerSpec, type ModelOption, type ModelProfile, type ProfileChoices, type Session, type SessionOptions, type UserDelivery, type Workspace } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";
import { newId } from "../../store/store.js";
import { MCP_SESSION_HEADER, type McpIdentities } from "../../mcp/identity.js";
import { AMO_MCP_NAME } from "../../mcp/tools.js";
import { PROMPTED_WRITE_TOOLS } from "../../mcp/names.js";
import { AGY_DEFAULT_PERMISSION, AGY_PERMISSIONS, agyPermissionMode } from "../choices.js";
import { RuntimeBase, STOP_GRACE_MS, type SendMode, type SendOptions, type SessionRuntimeApi } from "../runtime.js";
import { withDelivery } from "../items.js";
import { AcpConnection, AcpError } from "../acp.js";
import { shellHelpEnv, withoutHostEnv } from "../agent-env.js";
import { acpServer, mcpFits, mcpSkippedNotice, type McpSkipped, type McpSource, type McpTransports } from "../mcp-launch.js";
import { rotateLog } from "../dsh/dsh-runtime.js";
import { AGY_ALLOW, AGY_CHECK_KEY, AGY_MODE_OPTION, AGY_MODEL_OPTION, AGY_OPTIONS_KEY, AGY_REJECT, AGY_THOUGHT_OPTION, agyEnv, readAgyModels, resolveAgy } from "./install.js";
import { AgyTranscript, type AcpUpdate } from "./transcript.js";

// Gemini sessions on Google's Antigravity CLI over ACP (plans/agy.md, 2026-11-24). Each session runs its own
// `agy acp` in its workspace, as DSH's do; the sign-in is the person's own in agy (Studio never sees it). What was
// tried with a real agy (1.5.16, spikes/gemini/a00–a02): initialize, authenticate, session/new with MCP servers,
// set_config_option (model, thought_level, mode), set_mode, and session/load / resume / list in a new process. No turn
// ran (the Google account asked to be verified first), so the turn side follows ACP and t3code's agy driver: verify it
// with a real turn (plans/agy.md「回头要实测的」).
//
// What it does not do: fork (agy cannot roll its conversation back), question cards (ACP has none; decision_request
// instead), steering a running turn (a message sent meanwhile waits for the turn, as with DSH; 立即发送 cancels it).

export interface AgyRuntimeOptions {
  store: Store;
  profiles: readonly ModelProfile[];
  /** Studio's agy folder: `logs/` (agy's stderr), `probe/` (「检查」's scratch folder). */
  dir: string;
  /** The AMO MCP's address and its agent token, once the Host listens. */
  mcp?: () => { url: string; token: string } | null;
  /** MCP 设置: the session's other MCP servers (Studio's and the person's that are on). */
  mcpServers?: McpSource;
  identities?: McpIdentities;
  stopGraceMs?: number;
  /** Tests: the agent command instead of agy (a fake ACP agent). */
  agent?: { command: string; args: readonly string[] };
  /** Base environment for the agent processes (tests). */
  env?: NodeJS.ProcessEnv;
  /** A session's process is closed after this long without a turn (it is resumed on the next message). */
  idleMs?: number;
  now?: () => Date;
}

/** ACP's version Studio speaks (DSH's too). */
const ACP_VERSION = 1;

interface ConfigOption {
  id: string;
  name?: string;
  currentValue?: string;
  options?: Array<{ value?: string; name?: string; description?: string }>;
}

/** What agy offered last: its options and its model list (whose ids carry the thinking levels, `<model>-<level>`). */
interface Offered {
  configOptions: ConfigOption[];
  availableModels: Array<{ modelId: string; name?: string }>;
}

interface Waiting {
  approvalId: string;
  itemId: Id;
  options: Array<{ optionId: string; kind: string }>;
  answer(result: unknown): void;
}

interface QueuedMessage {
  itemId: Id;
  text: string;
  images: ImageBlock[];
}

interface ImageBlock {
  type: "image";
  mimeType: string;
  data: string;
}

interface Live {
  conn: AcpConnection;
  acpId: string;
  /** The process runs with --dangerously-skip-permissions (完全访问): a narrower permission needs a new process. */
  skip: boolean;
  /** Model, thinking level and mode last set on agy's session. */
  applied: { model?: string; effort?: string; mode?: string };
  inflight: boolean;
  queue: QueuedMessage[];
  killedOnStop?: boolean;
  images: boolean;
  transcript: AgyTranscript;
  waiting: Map<string, Waiting>;
  idleTimer: NodeJS.Timeout | null;
  mcpKey: string;
}

export class AgyRuntime extends RuntimeBase implements SessionRuntimeApi {
  private readonly live = new Map<Id, Live>();
  private readonly starting = new Map<Id, Promise<Live>>();
  private readonly mcpTold = new Map<Id, string>();
  private closing = false;

  constructor(private readonly options: AgyRuntimeOptions) {
    super(options.store, "agy", options.now, options.profiles);
    // The last Host stopped mid-turn: the turn is over (its process went with the Host).
    for (const s of this.store.listSessions()) {
      if (s.runtime !== "agy" || !inTurn(s.status)) continue;
      this.settleLeftovers(s.id, { approvals: true });
      this.setStatus(s.id, "interrupted");
    }
  }

  // ---- operations -------------------------------------------------------------------------------------------------

  async startSession(input: { taskId: Id | null; topicId: Id | null; profileId: Id; workspace: Workspace; title?: string; text?: string; options?: SessionOptions }): Promise<Session> {
    const profile = this.profile(input.profileId);
    const options = { ...(profile.model && !input.options?.model ? { model: profile.model } : {}), ...(input.options ?? {}) };
    const token = this.options.identities?.issue();
    const { skip } = agyPermissionMode(options.permission);
    const conn = this.spawn(input.workspace.path, skip, `new-${Date.now()}`);
    const extra = this.extraMcp({ workspaceId: input.workspace.id, ...(options.mcp ? { mcp: options.mcp } : {}) });
    let session: Session;
    let image = false;
    let skipped: McpSkipped[] = [];
    try {
      const init = await this.initialize(conn);
      image = init.image;
      const fit = fitMcp(extra.specs, init.mcp);
      skipped = fit.skipped;
      const created = await conn.request<{ sessionId: string } & SessionSetup>("session/new", { cwd: input.workspace.path, mcpServers: [...this.mcpServers(token), ...fit.list] });
      this.remember(created);
      session = this.createSession({
        taskId: input.taskId,
        topicId: input.topicId,
        parentId: null,
        kind: "main",
        profileId: profile.id,
        workspaceId: input.workspace.id,
        title: input.title ?? "",
        runtimeRef: created.sessionId,
        options,
      });
    } catch (err) {
      conn.kill();
      throw this.explain(err);
    }
    if (token) this.options.identities!.bind(token, session.id);
    const live = this.adopt(session, conn, skip, image);
    live.mcpKey = extra.key;
    this.tellSkippedMcp(session.id, skipped);
    await this.applyOptions(session.id, live);
    if (input.text) await this.sendMessage(session.id, input.text);
    return this.store.getSession(session.id)!;
  }

  async sendMessage(sessionId: Id, text: string, images: readonly Attachment[] = [], options: SendOptions = {}): Promise<{ mode: SendMode }> {
    const session = this.writable(sessionId);
    const blocks = imageBlocks(images);
    if (!session.title) this.updateSession(sessionId, { title: (text || "图片").slice(0, 60) });
    const shown = images.map((a) => ({ id: a.id, path: a.path }));
    return this.deliver(session, blocks, text, options, (mode, live, delivery) => {
      const item = { type: "user" as const, text, ...(shown.length ? { images: shown } : {}), ...(delivery ? { delivery } : {}) };
      return this.appendItem(sessionId, item, mode === "queue" ? { method: "user/queued", ...live.transcript.turnRef() } : { method: "user" }).id;
    });
  }

  /** One message into the session's process: a turn starts, or it waits for the running one (`waiting`). */
  private async deliver(session: Session, blocks: ImageBlock[], text: string, options: SendOptions, item: (mode: SendMode, live: Live, delivery: UserDelivery | undefined) => Id): Promise<{ mode: SendMode }> {
    const sessionId = session.id;
    const live = await this.ensureLive(session);
    if (blocks.length && !live.images) throw Object.assign(new Error("agy 说这个会话不收图片，图片没有发出去"), { code: "bad_request" });
    if (live.inflight) {
      const itemId = item("queue", live, "waiting");
      live.queue.push({ itemId, text, images: blocks });
      if (options.now === true) await this.sendNow(sessionId, itemId);
      return { mode: "queue" };
    }
    item("start", live, undefined);
    await this.prompt(sessionId, live, text, blocks);
    return { mode: "start" };
  }

  /** 立即发送 on a waiting message: the turn is cancelled and the waiting messages go at once as the next turn. */
  async sendNow(sessionId: Id, itemId: Id): Promise<void> {
    this.writable(sessionId);
    const live = this.live.get(sessionId);
    if (!live?.inflight || !live.queue.some((q) => q.itemId === itemId)) return;
    for (const w of live.waiting.values()) this.settleWaiting(sessionId, live, w, "cancelled");
    live.conn.notify("session/cancel", { sessionId: live.acpId });
  }

  async resend(sessionId: Id, itemId: Id, images: readonly Attachment[] = [], options: SendOptions = {}): Promise<{ mode: SendMode }> {
    const session = this.writable(sessionId);
    const it = this.store.getItem(itemId);
    if (it?.type !== "user" || it.sessionId !== sessionId) throw Object.assign(new Error(`message ${itemId} not found`), { code: "not_found" });
    if (it.delivery !== "unsent" && it.delivery !== "held") return { mode: this.live.get(sessionId)?.inflight ? "queue" : "start" };
    return this.deliver(session, imageBlocks(images), it.text, options, (_mode, _live, delivery) => {
      this.updateItem(itemId, (x) => (x.type === "user" ? withDelivery(x, delivery) : x));
      return itemId;
    });
  }

  async choices(profileId: Id): Promise<ProfileChoices> {
    this.profile(profileId);
    let offered = this.offered();
    if (!offered) {
      await this.probe().catch(() => undefined);
      offered = this.offered();
    }
    const base = { profileId, permissions: AGY_PERMISSIONS, defaultPermission: AGY_DEFAULT_PERMISSION };
    return { ...base, models: offered ? agyModels(offered, readAgyModels(this.store)) : [], source: offered ? "cli" : "builtin" };
  }

  /**
   * Model, thinking level and mode go to agy before the next turn (the mode at once). 完全访问 is a flag of the process:
   * switching to or from it starts the process again between turns; meanwhile Studio says yes to what agy asks when
   * the session is on 完全访问 (the requests waiting included).
   */
  async setOptions(sessionId: Id, options: SessionOptions): Promise<Session> {
    const updated = this.updateSession(sessionId, { options });
    const live = this.live.get(sessionId);
    if (!live) return updated;
    const to = agyPermissionMode(options.permission);
    if (to.skip) for (const w of [...live.waiting.values()]) this.settleWaiting(sessionId, live, w, "allow");
    if (!live.inflight) {
      if (live.skip !== to.skip) await this.release(sessionId);
      else await this.applyOptions(sessionId, live).catch((err: unknown) => this.emit("log", `agy set options failed for ${sessionId}: ${String(err)}`));
    } else if (live.skip === to.skip && to.mode !== live.applied.mode) {
      await this.setMode(live, to.mode).catch((err: unknown) => this.emit("log", `agy set mode failed for ${sessionId}: ${String(err)}`));
    }
    return updated;
  }

  async usage(): Promise<AccountUsage | null> {
    return null;
  }

  async rename(sessionId: Id, title: string): Promise<Session> {
    this.requireSession(sessionId);
    return this.updateSession(sessionId, { title });
  }

  async interrupt(sessionId: Id): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live?.inflight) return;
    for (const w of live.waiting.values()) this.settleWaiting(sessionId, live, w, "cancelled");
    // agy ends the prompt itself after a cancel (t3code: cancelBehavior "wait-for-prompt").
    live.conn.notify("session/cancel", { sessionId: live.acpId });
    const grace = this.options.stopGraceMs ?? STOP_GRACE_MS;
    const turnId = live.transcript.turnRef().turnId;
    this.armStopGrace(sessionId, grace, () => this.live.get(sessionId) === live && live.inflight && live.transcript.turnRef().turnId === turnId, () => {
      live.killedOnStop = true;
      this.appendItem(sessionId, { type: "notice", level: "warning", message: `点了停止 ${Math.round(grace / 1000)} 秒后 agy 还没停下，Studio 关掉了它的进程。发一条消息即可接着对话。` }, { method: "agy/stop", ...live.transcript.turnRef() });
      live.conn.kill();
    }, "closing its process");
  }

  async fork(): Promise<Session> {
    throw Object.assign(new Error("Gemini 会话不能分支（agy 不能退回自己的对话）"), { code: "bad_request" });
  }

  async archive(sessionId: Id): Promise<Session[]> {
    const changed = this.archiveTree(sessionId);
    for (const s of changed) await this.release(s.id);
    return changed;
  }

  async unarchive(sessionId: Id): Promise<Session[]> {
    return this.unarchiveTree(sessionId);
  }

  async respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const live = this.live.get(sessionId);
    const w = live?.waiting.get(approvalId);
    if (!live || !w) throw new Error(`approval ${approvalId} is not pending`);
    this.settleWaiting(sessionId, live, w, decision === "accept" ? "allow" : "reject");
  }

  async answerQuestion(): Promise<void> {
    throw new Error("agy sessions ask no questions through Studio");
  }

  async attachInfo(): Promise<{ url: string; token: string; threadId: string }> {
    throw Object.assign(new Error("Gemini 会话不能在终端打开"), { code: "bad_request" });
  }

  setWriter(sessionId: Id, writer: Session["writer"]): Session {
    return this.updateSession(sessionId, { writer });
  }

  /** 设置 → 模型 → Antigravity →「检查」: starts agy, opens a session in a scratch folder and closes it. No model call. */
  async check(): Promise<AgyCheck> {
    const resolved = this.options.agent ? null : resolveAgy(this.baseEnv());
    const version = resolved && !("error" in resolved) ? resolved.version : null;
    const at = this.now().toISOString();
    const result = (ok: boolean, message: string, needsLogin = false): AgyCheck => {
      const c: AgyCheck = { ok, at, message, version, ...(needsLogin ? { needsLogin } : {}) };
      this.store.setKv(AGY_CHECK_KEY, JSON.stringify(c));
      return c;
    };
    if (resolved && "error" in resolved) return result(false, resolved.error);
    try {
      const { protocolVersion, models } = await this.probe();
      return result(true, `可用 · ACP ${protocolVersion} · ${models} 个型号`);
    } catch (err) {
      const needsLogin = isAuthRequired(err);
      return result(false, needsLogin ? "agy 还没有登录：点「登录 Google 账号」" : `不能用：${this.explain(err).message}`, needsLogin);
    }
  }

  /**
   * 「登录 Google 账号」: agy's own sign-in through ACP (`authenticate`, oauth-personal): agy opens the browser and waits
   * for the person (11-24: 12 s when the browser was already signed in to Google); up to 5 minutes.
   */
  async login(): Promise<void> {
    const probe = join(this.options.dir, "probe");
    mkdirSync(probe, { recursive: true });
    const conn = this.spawn(probe, false, "login");
    try {
      await this.initialize(conn);
      await conn.request("authenticate", { methodId: "oauth-personal" }, 5 * 60_000);
    } catch (err) {
      throw this.explain(err);
    } finally {
      await conn.close(5_000);
    }
  }

  /** Starts agy and opens a session, no model call; keeps the models it offers. */
  private async probe(): Promise<{ protocolVersion: number; models: number }> {
    const probe = join(this.options.dir, "probe");
    mkdirSync(probe, { recursive: true });
    let conn: AcpConnection | null = null;
    try {
      conn = this.spawn(probe, false, "check");
      const init = await this.initialize(conn);
      const created = await conn.request<{ sessionId: string } & SessionSetup>("session/new", { cwd: probe, mcpServers: [] }, 60_000);
      this.remember(created);
      await conn.request("session/close", { sessionId: created.sessionId }, 30_000).catch(() => undefined);
      const offered = this.offered();
      return { protocolVersion: init.protocolVersion, models: offered ? agyModels(offered, []).length : 0 };
    } finally {
      await conn?.close(5_000);
    }
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.live.keys()].map((id) => this.release(id)));
  }

  // ---- processes --------------------------------------------------------------------------------------------------

  /** Tests: the stand-in sessions run instead of agy (设置 shows it as the agy in use). */
  testAgent(): { command: string; args: readonly string[] } | null {
    return this.options.agent ?? null;
  }

  /** The environment agy starts from (the Host's, or a test's), before agyEnv. */
  baseEnv(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private spawn(cwd: string, skip: boolean, label: string): AcpConnection {
    const env: NodeJS.ProcessEnv = agyEnv({ ...shellHelpEnv(this.store), ...withoutHostEnv(this.baseEnv()) });
    let command: string;
    let args: string[];
    if (this.options.agent) {
      command = this.options.agent.command;
      args = [...this.options.agent.args];
    } else {
      const launch = resolveAgy(this.baseEnv());
      if ("error" in launch) throw Object.assign(new Error(launch.error), { code: "bad_request" });
      command = launch.path;
      args = ["acp"];
    }
    if (skip) args.push("--dangerously-skip-permissions");
    const logFile = join(this.options.dir, "logs", `${label}.log`);
    rotateLog(logFile);
    return new AcpConnection({ command, args, cwd, env, logFile, label: "agy" }, (method, params) => this.onRequest(method, params));
  }

  /**
   * ACP's handshake. `fs.writeTextFile: false` on purpose: t3code's notes say agy writes whole files instead of
   * editing when a client says it can write. agy 1.5.16 says nothing of MCP transports, yet took an HTTP server at
   * session/new (spikes/gemini/a02): HTTP is offered unless it says no.
   */
  private async initialize(conn: AcpConnection): Promise<{ protocolVersion: number; image: boolean; mcp: McpTransports }> {
    const init = await conn.request<{ protocolVersion: number; agentCapabilities?: { promptCapabilities?: { image?: boolean }; mcpCapabilities?: { http?: boolean; sse?: boolean } } }>(
      "initialize",
      { protocolVersion: ACP_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "amo-studio", title: "AMO Studio", version: "1" } },
      120_000,
    );
    if (init.protocolVersion !== ACP_VERSION) throw new Error(`agy 说的是 ACP ${init.protocolVersion}，Studio 只会 ACP ${ACP_VERSION}`);
    const mcp = init.agentCapabilities?.mcpCapabilities;
    return { protocolVersion: init.protocolVersion, image: init.agentCapabilities?.promptCapabilities?.image === true, mcp: { http: mcp?.http !== false, sse: mcp?.sse === true } };
  }

  private ensureLive(session: Session): Promise<Live> {
    const existing = this.live.get(session.id);
    if (existing?.conn.alive) return Promise.resolve(existing);
    const pending = this.starting.get(session.id);
    if (pending) return pending;
    const p = (async () => {
      if (!session.runtimeRef) throw new Error(`session ${session.id} has no agy session`);
      const workspace = this.store.getWorkspace(session.workspaceId);
      if (!workspace) throw new Error(`workspace ${session.workspaceId} not found`);
      const { skip } = agyPermissionMode(session.options.permission);
      const conn = this.spawn(workspace.path, skip, session.id);
      let image = false;
      const extra = this.extraMcp(session.id);
      let skipped: McpSkipped[] = [];
      try {
        const init = await this.initialize(conn);
        image = init.image;
        const fit = fitMcp(extra.specs, init.mcp);
        skipped = fit.skipped;
        const token = this.options.identities?.tokenFor(session.id);
        const resumed = await conn.request<SessionSetup>("session/resume", { sessionId: session.runtimeRef, cwd: workspace.path, mcpServers: [...this.mcpServers(token), ...fit.list] });
        this.remember(resumed);
      } catch (err) {
        conn.kill();
        throw this.explain(err);
      }
      const live = this.adopt(session, conn, skip, image);
      live.mcpKey = extra.key;
      this.tellSkippedMcp(session.id, skipped);
      await this.applyOptions(session.id, live);
      return live;
    })().finally(() => this.starting.delete(session.id));
    this.starting.set(session.id, p);
    return p;
  }

  private adopt(session: Session, conn: AcpConnection, skip: boolean, images: boolean): Live {
    const live: Live = { conn, acpId: session.runtimeRef!, skip, applied: {}, inflight: false, queue: [], images, transcript: new AgyTranscript(this.makeCore(), session.id, this.store.getWorkspace(session.workspaceId)?.path), waiting: new Map(), idleTimer: null, mcpKey: "" };
    this.live.set(session.id, live);
    conn.on("notification", (method, params) => {
      if (method !== "session/update") return;
      const p = params as { sessionId?: string; update?: AcpUpdate };
      if (p.sessionId !== live.acpId || !p.update) return;
      // Released (idle, archived, the Host closing): what agy still had on its stdout is read after the process exited,
      // and the Host closes the store right after closeAll — writing it threw from this listener (2026-11-24, an
      // unhandled "database is not open" when a test ended between agy's reply and its usage_update).
      if (this.closing || this.live.get(session.id) !== live) return;
      // agy replays a session's history on load: only what comes during a turn of Studio's is shown (Studio keeps the rest).
      if (!live.inflight) return;
      if (p.update.sessionUpdate === "current_mode_update" && p.update.currentModeId) live.applied.mode = p.update.currentModeId;
      live.transcript.update(p.update);
    });
    conn.on("exit", (code) => {
      if (this.live.get(session.id) === live) this.live.delete(session.id);
      if (live.idleTimer) clearTimeout(live.idleTimer);
      if (!this.closing && live.inflight) this.emit("log", `agy process of ${session.id} exited mid-turn (${code})`);
    });
    this.armIdle(session.id, live);
    return live;
  }

  /** Ends the session's process (idle, archived, or for 完全访问 going on or off). */
  private async release(sessionId: Id): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    this.live.delete(sessionId);
    if (live.idleTimer) clearTimeout(live.idleTimer);
    for (const w of live.waiting.values()) this.settleWaiting(sessionId, live, w, "cancelled");
    this.unsent(live);
    if (live.conn.alive) {
      await live.conn.request("session/close", { sessionId: live.acpId }, 15_000).catch(() => undefined);
      await live.conn.close();
    }
  }

  private armIdle(sessionId: Id, live: Live): void {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
    if (live.inflight) return;
    live.idleTimer = setTimeout(() => {
      if (!live.inflight && this.live.get(sessionId) === live) void this.release(sessionId);
    }, this.options.idleMs ?? 20 * 60_000);
    live.idleTimer.unref();
  }

  // ---- turns ------------------------------------------------------------------------------------------------------

  private async prompt(sessionId: Id, live: Live, text: string, images: readonly ImageBlock[] = [], sent: readonly Id[] = []): Promise<void> {
    live.inflight = true;
    live.killedOnStop = false;
    for (const id of sent) this.updateItem(id, (it) => (it.type === "user" ? withDelivery(it, undefined) : it));
    if (live.idleTimer) clearTimeout(live.idleTimer);
    await this.applyOptions(sessionId, live).catch((err: unknown) => this.emit("log", `agy set options failed for ${sessionId}: ${String(err)}`));
    live.transcript.openTurn();
    this.setStatus(sessionId, "running");
    live.conn
      .request<{ stopReason?: string }>("session/prompt", { sessionId: live.acpId, prompt: [...(text ? [{ type: "text", text }] : []), ...images] }, 0)
      .then(
        (r) => this.endTurn(sessionId, live, r.stopReason ?? "end_turn"),
        (err: unknown) => this.endTurn(sessionId, live, "error", this.explain(err).message),
      )
      .catch((err: unknown) => this.emit("log", `agy turn end failed for ${sessionId}: ${String(err)}`));
  }

  private async endTurn(sessionId: Id, live: Live, stopReason: string, error?: string): Promise<void> {
    if (this.closing) return;
    if (error && live.killedOnStop) {
      stopReason = "cancelled";
      error = undefined;
    }
    for (const w of live.waiting.values()) this.settleWaiting(sessionId, live, w, "cancelled");
    live.transcript.closeTurn(stopReason, error);
    live.inflight = false;
    if (error) {
      this.unsent(live);
      this.appendItem(sessionId, { type: "error", message: error }, { method: "session/prompt" });
      this.setStatus(sessionId, "error");
      this.armIdle(sessionId, live);
      return;
    }
    // 完全访问 switched, or the MCP servers changed, during the turn: the process starts again for what waits.
    const session = this.store.getSession(sessionId);
    if (session && (live.skip !== agyPermissionMode(session.options.permission).skip || this.mcpChanged(sessionId, live)) && this.live.get(sessionId) === live) {
      const queued = live.queue.splice(0);
      await this.release(sessionId);
      if (!queued.length) return this.setStatus(sessionId, "idle");
      try {
        const fresh = await this.ensureLive(session);
        fresh.queue.push(...queued);
        const next = takeQueue(fresh)!;
        await this.prompt(sessionId, fresh, next.text, next.images, next.items);
      } catch (err) {
        for (const q of queued) this.updateItem(q.itemId, (it) => (it.type === "user" && it.delivery === "waiting" ? withDelivery(it, "unsent") : it));
        this.appendItem(sessionId, { type: "error", message: this.explain(err).message }, { method: "session/resume" });
        this.setStatus(sessionId, "error");
      }
      return;
    }
    if (live.queue.length && live.conn.alive && this.live.get(sessionId) === live) {
      const next = takeQueue(live)!;
      await this.prompt(sessionId, live, next.text, next.images, next.items);
      return;
    }
    this.unsent(live);
    this.setStatus(sessionId, "idle");
    this.armIdle(sessionId, live);
  }

  private unsent(live: Live): void {
    for (const q of live.queue.splice(0)) this.updateItem(q.itemId, (it) => (it.type === "user" && it.delivery === "waiting" ? withDelivery(it, "unsent") : it));
  }

  private async setMode(live: Live, mode: string): Promise<void> {
    await live.conn.request("session/set_config_option", { sessionId: live.acpId, configId: AGY_MODE_OPTION, value: mode });
    live.applied.mode = mode;
  }

  /** The session's model, thinking level (Gemini only; agy refuses it for the others) and mode, where they changed. */
  private async applyOptions(sessionId: Id, live: Live): Promise<void> {
    const session = this.store.getSession(sessionId);
    const opts = session?.options ?? {};
    if (opts.model && opts.model !== live.applied.model) {
      const r = await live.conn.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", { sessionId: live.acpId, configId: AGY_MODEL_OPTION, value: opts.model });
      live.applied.model = opts.model;
      live.applied.effort = undefined;
      this.rememberOptions(r.configOptions);
    }
    const levels = this.offered() ? effortsOf(this.offered()!, opts.model ?? currentModel(this.offered()!)) : [];
    if (opts.effort && opts.effort !== live.applied.effort && levels.includes(opts.effort)) {
      await live.conn.request("session/set_config_option", { sessionId: live.acpId, configId: AGY_THOUGHT_OPTION, value: opts.effort });
      live.applied.effort = opts.effort;
    }
    const { mode } = agyPermissionMode(opts.permission);
    if (mode !== live.applied.mode) await this.setMode(live, mode);
  }

  // ---- approvals --------------------------------------------------------------------------------------------------

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== "session/request_permission") throw new AcpError(`Studio does not handle ${method}`, -32601);
    const p = params as { sessionId?: string; toolCall?: AcpUpdate & { toolCallId?: string }; options?: Array<{ optionId: string; kind: string; name?: string }> };
    const entry = [...this.live.entries()].find(([, l]) => l.acpId === p.sessionId);
    if (!entry) return { outcome: { outcome: "cancelled" } };
    const [sessionId, live] = entry;
    const allow = (p.options ?? []).find((o) => o.kind === AGY_ALLOW);
    // AMO's own tools: as with Codex, the ones that need no approval run unasked (the title naming AMO's server is a
    // guess from t3code's notes; not seen from agy yet).
    const amoTool = amoToolOf(p.toolCall);
    if (allow && amoTool && !(PROMPTED_WRITE_TOOLS as readonly string[]).includes(amoTool)) return { outcome: { outcome: "selected", optionId: allow.optionId } };
    const shown = live.transcript.approvalText(p.toolCall?.toolCallId, p.toolCall);
    const approvalId = newId("ap");
    if (allow && agyPermissionMode(this.store.getSession(sessionId)?.options.permission).skip) {
      this.appendItem(sessionId, { type: "approval", approvalId, kind: shown.kind, summary: shown.summary, detail: "完全访问：Studio 已直接同意", state: "accepted" }, { method, ...(p.toolCall?.toolCallId ? { itemId: p.toolCall.toolCallId } : {}), ...live.transcript.turnRef() });
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    }
    return new Promise((resolve) => {
      const item = this.appendItem(sessionId, { type: "approval", approvalId, kind: shown.kind, summary: shown.summary, ...(shown.detail ? { detail: shown.detail } : {}), state: "pending" }, { method, ...(p.toolCall?.toolCallId ? { itemId: p.toolCall.toolCallId } : {}), ...live.transcript.turnRef() });
      live.waiting.set(approvalId, { approvalId, itemId: item.id, options: p.options ?? [], answer: resolve });
      this.setStatus(sessionId, "awaiting-approval");
    });
  }

  private settleWaiting(sessionId: Id, live: Live, w: Waiting, how: "allow" | "reject" | "cancelled"): void {
    live.waiting.delete(w.approvalId);
    const kind = how === "allow" ? AGY_ALLOW : AGY_REJECT;
    const option = w.options.find((o) => o.kind === kind);
    w.answer(how === "cancelled" || !option ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: option.optionId } });
    this.updateItem(w.itemId, (it) => (it.type === "approval" && it.state === "pending" ? { ...it, state: how === "allow" ? "accepted" : "declined" } : it));
    if (!live.waiting.size && live.inflight && this.store.getSession(sessionId)?.status === "awaiting-approval") this.setStatus(sessionId, "running");
  }

  // ---- helpers ----------------------------------------------------------------------------------------------------

  private extraMcp(target: Id | { workspaceId: Id; mcp?: Record<string, boolean> }): { specs: Array<[string, McpServerSpec]>; key: string } {
    try {
      const plan = this.options.mcpServers?.launch(target, false);
      if (!plan) return { specs: [], key: "" };
      const names = Object.keys(plan.explicit).sort();
      return { specs: names.map((n) => [n, plan.explicit[n]!]), key: JSON.stringify(names.map((n) => [n, plan.explicit[n]])) };
    } catch (err) {
      this.emit("log", `MCP servers for an agy session could not be read: ${String(err)}`);
      return { specs: [], key: "" };
    }
  }

  private tellSkippedMcp(sessionId: Id, skipped: ReadonlyArray<McpSkipped>): void {
    const message = skipped.length ? mcpSkippedNotice(skipped, "Gemini") : "";
    if (this.mcpTold.get(sessionId) === message) return;
    this.mcpTold.set(sessionId, message);
    if (message) this.appendItem(sessionId, { type: "notice", level: "warning", message }, { method: "agy/mcp" });
  }

  private mcpChanged(sessionId: Id, live: Live): boolean {
    return !!this.options.mcpServers && this.extraMcp(sessionId).key !== live.mcpKey;
  }

  async refreshMcp(sessionId: Id): Promise<McpApply> {
    const live = this.live.get(sessionId);
    if (!live) return "next-message";
    if (!this.mcpChanged(sessionId, live)) return "now";
    if (live.inflight) return "after-turn";
    await this.release(sessionId);
    return "next-message";
  }

  private mcpServers(token: string | undefined): unknown[] {
    const mcp = this.options.mcp?.();
    if (!mcp || !token) return [];
    return [{ type: "http", name: AMO_MCP_NAME, url: mcp.url, headers: [{ name: "Authorization", value: `Bearer ${mcp.token}` }, { name: MCP_SESSION_HEADER, value: token }] }];
  }

  /** Keeps what agy offered (session/new, resume, 检查), for the pickers. */
  private remember(setup: SessionSetup | undefined): void {
    if (!setup?.configOptions?.length) return;
    this.store.setKv(AGY_OPTIONS_KEY, JSON.stringify({ configOptions: setup.configOptions, availableModels: setup.models?.availableModels ?? this.offered()?.availableModels ?? [] } satisfies Offered));
  }

  /** After a model switch agy answers with its options again (thought_level only for the models that have it). */
  private rememberOptions(config: ConfigOption[] | undefined): void {
    const known = this.offered();
    if (!config?.length || !known) return;
    // The model list stays the one from session/new: the answer to a switch says only which levels the new model has.
    this.store.setKv(AGY_OPTIONS_KEY, JSON.stringify({ ...known, configOptions: known.configOptions.map((c) => (c.id === AGY_MODEL_OPTION ? c : (config.find((x) => x.id === c.id) ?? c))) } satisfies Offered));
  }

  offered(): Offered | null {
    try {
      const v = JSON.parse(this.store.getKv(AGY_OPTIONS_KEY)?.value ?? "null") as Offered | null;
      return v && Array.isArray(v.configOptions) ? { configOptions: v.configOptions, availableModels: Array.isArray(v.availableModels) ? v.availableModels : [] } : null;
    } catch {
      return null;
    }
  }

  private explain(err: unknown): Error {
    if (err instanceof Error && (err as { code?: unknown }).code === "bad_request") return err;
    if (isAuthRequired(err)) return Object.assign(new Error("agy 还没有登录 Google 账号：到 设置 → 模型 → Antigravity 点「登录 Google 账号」"), { code: "bad_request" });
    const data = err instanceof AcpError && err.data && typeof err.data === "object" ? JSON.stringify(err.data).slice(0, 300) : "";
    const message = (err instanceof Error ? err.message : String(err)) + (data && data !== "{}" ? `（${data}）` : "");
    return Object.assign(new Error(message.startsWith("agy") ? message : `agy：${message}`), { code: "runtime_error" });
  }

  private profile(id: Id): ModelProfile {
    const p = this.options.profiles.find((x) => x.id === id);
    if (!p || p.runtime !== "agy") throw new Error(`profile ${id} is not an agy profile`);
    return p;
  }
}

/** What session/new, load and resume answer with (spikes/gemini/a00–a02). */
interface SessionSetup {
  configOptions?: ConfigOption[];
  models?: { availableModels?: Array<{ modelId: string; name?: string }>; currentModelId?: string };
}

/** agy refused for want of a sign-in ("Authentication required", 1.5.16). */
export function isAuthRequired(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /authentication required|not logged in|auth(entication)? (is )?required/i.test(m);
}

/** The AMO tool an agy permission request is for, when its title or input names AMO's MCP server; else null. */
export function amoToolOf(toolCall: { title?: string; rawInput?: unknown } | undefined): string | null {
  const title = toolCall?.title ?? "";
  const hit = new RegExp(`(?:^|[\\s(\`"'])(?:mcp__)?${AMO_MCP_NAME}(?:__|/|:|\\.)([a-z_]+)`).exec(title);
  if (hit) return hit[1]!;
  const input = toolCall?.rawInput && typeof toolCall.rawInput === "object" ? (toolCall.rawInput as Record<string, unknown>) : {};
  const server = input.server ?? input.serverName ?? input.ServerName;
  const tool = input.tool ?? input.toolName ?? input.ToolName;
  return server === AMO_MCP_NAME && typeof tool === "string" ? tool : null;
}

/** The model agy's options say is current. */
function currentModel(o: Offered): string | undefined {
  return o.configOptions.find((c) => c.id === AGY_MODEL_OPTION)?.currentValue;
}

/** The thinking levels of `model`: agy's model list names them as `<model>-<level>` (gemini-3.8-flash-high). */
export function effortsOf(o: Offered, model: string | undefined): string[] {
  if (!model) return [];
  const levels = o.configOptions.find((c) => c.id === AGY_THOUGHT_OPTION)?.options?.map((x) => x.value).filter((v): v is string => !!v) ?? ["low", "medium", "high"];
  const ids = new Set(o.availableModels.map((m) => m.modelId));
  const found = levels.filter((l) => ids.has(`${model}-${l}`));
  return found;
}

/**
 * agy's models as Studio's: Gemini always, the others (Claude, GPT-OSS through Google) only when the person turned them
 * on in 设置 (the user, 2026-11-24: 默认不可选，但是可以在设置里将这些选出来). Each with its thinking levels.
 */
export function agyModels(o: Offered, extra: readonly string[]): ModelOption[] {
  const model = o.configOptions.find((c) => c.id === AGY_MODEL_OPTION);
  const thought = o.configOptions.find((c) => c.id === AGY_THOUGHT_OPTION);
  const current = model?.currentValue;
  return (model?.options ?? [])
    .filter((x): x is { value: string; name?: string; description?: string } => !!x.value)
    .filter((x) => isGemini(x.value) || extra.includes(x.value))
    .map((x) => {
      const efforts = effortsOf(o, x.value);
      return {
        id: x.value,
        label: x.name ?? x.value,
        ...(x.description ? { description: x.description } : {}),
        efforts,
        ...(efforts.length && thought?.currentValue && efforts.includes(thought.currentValue) ? { defaultEffort: thought.currentValue } : {}),
        ...(x.value === current ? { isDefault: true } : {}),
      };
    });
}

/** Every model agy offers, for 设置's list of the ones to turn on. */
export function agyOffered(o: Offered | null): Array<{ id: string; label: string }> {
  const model = o?.configOptions.find((c) => c.id === AGY_MODEL_OPTION);
  return (model?.options ?? []).filter((x) => !!x.value).map((x) => ({ id: x.value!, label: x.name ?? x.value! }));
}

export function isGemini(id: string): boolean {
  return /^gemini/i.test(id);
}

function imageBlocks(images: readonly Attachment[]): ImageBlock[] {
  return images.map((a) => ({ type: "image", mimeType: a.mime, data: readFileSync(a.path).toString("base64") }));
}

function takeQueue(live: Live): { text: string; images: ImageBlock[]; items: Id[] } | null {
  const queued = live.queue.splice(0);
  if (!queued.length) return null;
  return { text: queued.map((q) => q.text).filter(Boolean).join("\n\n"), images: queued.flatMap((q) => q.images), items: queued.map((q) => q.itemId) };
}

/** The servers agy takes in ACP's shape, and the ones it cannot. */
function fitMcp(specs: ReadonlyArray<[string, McpServerSpec]>, transports: McpTransports): { list: Array<Record<string, unknown>>; skipped: McpSkipped[] } {
  const list: Array<Record<string, unknown>> = [];
  const skipped: McpSkipped[] = [];
  for (const [name, spec] of specs) {
    if (mcpFits(spec, transports)) list.push(acpServer(name, spec));
    else skipped.push({ name, type: spec.type });
  }
  return { list, skipped };
}
