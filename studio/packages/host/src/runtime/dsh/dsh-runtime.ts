import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountUsage, ApprovalDecision, Attachment, DshCheck, Id, ModelOption, ModelProfile, ProfileChoices, QuestionReply, Session, SessionOptions, Workspace } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";
import { newId } from "../../store/store.js";
import { MCP_SESSION_HEADER, type McpIdentities } from "../../mcp/identity.js";
import { DSH_DEFAULT_PERMISSION, DSH_PERMISSIONS, dshPermissionMode } from "../choices.js";
import type { CredentialReader } from "../credentials.js";
import { RuntimeBase, type SendMode, type SessionRuntimeApi } from "../runtime.js";
import { AcpConnection, AcpError } from "./acp.js";
import { dshTurnStats } from "./session-log.js";
import {
  ACP_VERSION,
  DSH_ACP_ARGS,
  DSH_ALLOW,
  DSH_CHECK_KEY,
  DSH_EFFORT_OPTION,
  DSH_HOME_ENV,
  DSH_BASE_URL_ENV,
  DSH_KEY_ENV,
  DSH_MODEL_OPTION,
  DSH_OPTIONS_KEY,
  DSH_PERMISSION_ENV,
  DSH_REJECT,
  describeDsh,
  dshUnavailable,
  readDshPath,
  resolveNode,
  type DshPermissionMode,
} from "./install.js";
import { DshTranscript, toolOutput, type AcpUpdate } from "./transcript.js";
import { grantFailurePath, windowsFolderAccess, type FolderAccess, type FolderAccessState } from "./folder-access.js";

// DeepSeek sessions on a DeepSeek Harness source clone (stage 17, plans/stage-17-dsh.md). Each session runs its own
// `node <clone>/apps/cli/lib/bin.js --profile acp` in its workspace: DSH's sandbox follows the process's working
// directory and its permission mode is the process's environment. Studio's DSH home (`<data>/dsh/home`) keeps DSH's
// own sessions; Studio keeps the conversation (DSH does not replay it on resume). What ACP lacks (spikes s17-00):
// fork, question cards, images, steering a running turn (a message sent meanwhile waits for the turn to end).

/** A third-party DeepSeek endpoint DSH can be pointed at (an Anthropic Messages root, like https://api.deepseek.com/anthropic). */
export interface DshProviderDef {
  baseUrl?: string;
  /**
   * The site's own model names (2026-10-19): given to DSH as its catalog (a `--patch` overlay), since DSH sends a
   * model's catalog id as is and a relay may know DeepSeek's models by other names (`deepseek/deepseek-v4-pro`).
   */
  models?: string[];
}

export interface DshRuntimeOptions {
  store: Store;
  profiles: readonly ModelProfile[];
  credentials: CredentialReader;
  /** Third-party DeepSeek channels by provider id (2026-10-19): the address their sessions' DSH talks to. */
  providers?: Record<string, DshProviderDef>;
  /** Studio's DSH folder: `home/` (DSH_HOME), `logs/`, `probe/`. */
  dir: string;
  /** The AMO MCP's address and its agent token, once the Host listens. */
  mcp?: () => { url: string; token: string } | null;
  identities?: McpIdentities;
  /** Tests: the agent command instead of node + the clone's CLI (a fake ACP agent). */
  agent?: { command: string; args: readonly string[] };
  /** Base environment for the agent processes (tests). */
  env?: NodeJS.ProcessEnv;
  /** A session's process is closed after this long without a turn (it is resumed on the next message). */
  idleMs?: number;
  /**
   * Reads and fixes the Windows permissions DSH's write sandbox needs on a session's folder (folder-access.ts); null
   * turns it off. `icacls` on Windows unless `agent` is given (tests), none elsewhere.
   */
  folderAccess?: FolderAccess | null;
  now?: () => Date;
}

/** The folder-access notice's words for each step of the fix. */
function folderAccessMessage(state: "offered" | "running" | "done" | "failed", path: string, extra = ""): string {
  switch (state) {
    case "offered":
      return `DSH 的「写入」沙箱在「${path}」上设不起来：Windows 里你对这个文件夹没有可继承的「完全控制」权限（一般只有「修改」），沙箱要给它设的权限设不上，于是命令会一条条来要你批准，或者写不进里面已有的文件夹。修复会给你自己加上这个文件夹及其子文件夹的完全控制（原来的权限先备份），沙箱的防护不变。`;
    case "running":
      return `正在修复「${path}」的文件夹权限…文件多的项目要几分钟。`;
    case "done":
      return `「${path}」的文件夹权限已修好，DSH 的写入沙箱可以用了；刚才没跑成的命令让它再跑一次即可。原来的权限备份在 ${extra}（在上一级文件夹里用 icacls /restore 可以放回去）。`;
    case "failed":
      return `修复「${path}」的文件夹权限没成功：${extra}`;
  }
}

interface ConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<{ value?: string; name?: string; description?: string; group?: string; options?: Array<{ value: string; name?: string; description?: string }> }>;
}

interface Waiting {
  approvalId: string;
  itemId: Id;
  options: Array<{ optionId: string; kind: string }>;
  answer(result: unknown): void;
}

interface Live {
  conn: AcpConnection;
  acpId: string;
  permission: DshPermissionMode;
  /** Model and effort last set on the DSH session. */
  applied: { model?: string; effort?: string };
  inflight: boolean;
  /** Messages sent while a turn runs, sent together when it ends. */
  queue: string[];
  transcript: DshTranscript;
  waiting: Map<string, Waiting>;
  idleTimer: NodeJS.Timeout | null;
  /** When the running turn's speed was last read from DSH's log. */
  measuredAt: number;
}

/** How often a running turn's speed is read again from DSH's log (on a model call's usage report). */
const MEASURE_EVERY_MS = 30_000;

const BUSY = new Set(["running", "awaiting-approval", "awaiting-answer"]);

export class DshRuntime extends RuntimeBase implements SessionRuntimeApi {
  private readonly live = new Map<Id, Live>();
  /** Sessions whose process is being started or resumed. */
  private readonly starting = new Map<Id, Promise<Live>>();
  private closing = false;
  private readonly folderAccess: FolderAccess | null;
  /** Each session's folder-access notice in this run, and each folder's permissions as last read. */
  private readonly folderNotices = new Map<Id, Id>();
  private readonly folderChecks = new Map<string, Promise<FolderAccessState | null>>();

  constructor(private readonly options: DshRuntimeOptions) {
    super(options.store, "dsh", options.now);
    this.folderAccess =
      options.folderAccess !== undefined ? options.folderAccess : options.agent || process.platform !== "win32" ? null : windowsFolderAccess(join(options.dir, "acl-backup"));
    // The last Host stopped mid-turn: the turn is over (its process went with the Host).
    for (const s of this.store.listSessions()) {
      if (s.runtime !== "dsh" || !BUSY.has(s.status)) continue;
      new DshTranscript(this.makeCore(), s.id).settleAfterRestart();
      this.setStatus(s.id, "idle");
    }
  }

  // ---- operations -------------------------------------------------------------------------------------------------

  async startSession(input: { taskId: Id | null; topicId: Id | null; profileId: Id; workspace: Workspace; title?: string; text?: string; options?: SessionOptions }): Promise<Session> {
    const profile = this.profile(input.profileId);
    // A channel's own model when none was picked (DSH's catalog id, `deepseek-official/<model>`).
    const options = { ...(profile.model && !input.options?.model ? { model: profile.model } : {}), ...(input.options ?? {}) };
    const token = this.options.identities?.issue();
    const permission = dshPermissionMode(options.permission);
    const conn = this.spawn(input.workspace.path, profile, permission, `new-${Date.now()}`);
    let session: Session;
    try {
      await this.initialize(conn);
      const created = await conn.request<{ sessionId: string; configOptions?: ConfigOption[] }>("session/new", { cwd: input.workspace.path, mcpServers: this.mcpServers(token) });
      this.remember(created.configOptions, profile);
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
    const live = this.adopt(session, conn, {}, permission);
    await this.applyOptions(session.id, live);
    if (input.text) await this.sendMessage(session.id, input.text);
    return this.store.getSession(session.id)!;
  }

  async sendMessage(sessionId: Id, text: string, images: readonly Attachment[] = []): Promise<{ mode: SendMode }> {
    const session = this.writable(sessionId);
    if (images.length) throw Object.assign(new Error("DSH 会话暂时不能发图片（DSH 的 ACP 不收图片）"), { code: "bad_request" });
    if (!session.title) this.updateSession(sessionId, { title: text.slice(0, 60) });
    const live = await this.ensureLive(session);
    if (live.inflight) {
      // Shown in the running turn (as Claude's queued messages are), so that turn still reads as running.
      this.appendItem(sessionId, { type: "user", text }, { method: "user/queued", ...live.transcript.turnRef() });
      live.queue.push(text);
      return { mode: "queue" };
    }
    this.appendItem(sessionId, { type: "user", text }, { method: "user" });
    await this.prompt(sessionId, live, text);
    return { mode: "start" };
  }

  async choices(profileId: Id): Promise<ProfileChoices> {
    const profile = this.profile(profileId);
    let config = this.cachedOptions();
    if (!config) {
      await this.check();
      config = this.cachedOptions();
    }
    const base = { profileId, permissions: DSH_PERMISSIONS, defaultPermission: DSH_DEFAULT_PERMISSION };
    // A channel with its own model names: those (the efforts are DSH's).
    const own = this.ownModels(profile);
    if (own) return { ...base, models: channelModels(own, profile.model, config), source: "builtin" };
    return { ...base, models: config ? dshModels(config) : [], source: config ? "cli" : "builtin" };
  }

  /**
   * Model and effort go to DSH before the next turn. A new permission restarts the session's process (at once when it
   * is idle, else once the running turn ends), which is all an older DSH needed. DSH 0.2 writes the permission a session
   * starts with into the session itself and keeps it across restarts (2026-10-22: a session switched to 完全访问 went on
   * asking after a stop and 继续), so: 完全访问 is Studio saying yes to whatever DSH asks, the requests already waiting
   * included, from the moment it is chosen (as in DSH's own CLI); a stricter permission cannot reach a session that
   * has started, and the session says so.
   */
  async setOptions(sessionId: Id, options: SessionOptions): Promise<Session> {
    const before = this.requireSession(sessionId);
    const updated = this.updateSession(sessionId, { options });
    const from = dshPermissionMode(before.options.permission);
    const to = dshPermissionMode(options.permission);
    const live = this.live.get(sessionId);
    if (from !== to && before.runtimeRef) {
      const message =
        to === "danger-full-access"
          ? "已切到完全访问：DSH 再要权限时 Studio 直接同意（正在等的也一并同意）"
          : "DSH 把会话开始时的权限记在会话里，已经开始的会话收紧权限不会生效（放宽到完全访问可以）；要更严的权限，请新开一个会话";
      this.appendItem(sessionId, { type: "notice", level: "info", message }, { method: "dsh/permission", ...(live?.inflight ? live.transcript.turnRef() : {}) });
    }
    if (!live) return updated;
    if (to === "danger-full-access") for (const w of [...live.waiting.values()]) this.settleWaiting(sessionId, live, w, "allow");
    if (!live.inflight) {
      if (live.permission !== to) await this.release(sessionId);
      else await this.applyOptions(sessionId, live).catch((err: unknown) => this.emit("log", `dsh set options failed for ${sessionId}: ${String(err)}`));
    }
    return updated;
  }

  async usage(): Promise<AccountUsage | null> {
    return null;
  }

  /** ACP has no titles: only Studio's changes. */
  async rename(sessionId: Id, title: string): Promise<Session> {
    this.requireSession(sessionId);
    return this.updateSession(sessionId, { title });
  }

  async interrupt(sessionId: Id): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live?.inflight) return;
    const dropped = live.queue.splice(0);
    if (dropped.length) this.appendItem(sessionId, { type: "notice", level: "info", message: `停止后，排队的 ${dropped.length} 条消息没有发出` }, { method: "dsh/queue-dropped" });
    for (const w of live.waiting.values()) this.settleWaiting(sessionId, live, w, "cancelled");
    live.conn.notify("session/cancel", { sessionId: live.acpId });
  }

  async fork(): Promise<Session> {
    throw Object.assign(new Error("DSH 会话不能分支（DSH 的 ACP 不支持 fork）"), { code: "bad_request" });
  }

  async archive(sessionId: Id): Promise<Session[]> {
    const changed = this.store.archiveSubtree(sessionId);
    for (const s of changed) this.publish({ type: "session.upserted", session: s });
    for (const s of changed) await this.release(s.id);
    return changed;
  }

  async unarchive(sessionId: Id): Promise<Session[]> {
    const changed = this.store.unarchiveSubtree(sessionId);
    for (const s of changed) this.publish({ type: "session.upserted", session: s });
    return changed;
  }

  async respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const live = this.live.get(sessionId);
    const w = live?.waiting.get(approvalId);
    if (!live || !w) throw new Error(`approval ${approvalId} is not pending`);
    this.settleWaiting(sessionId, live, w, decision === "accept" ? "allow" : "reject");
  }

  async answerQuestion(): Promise<void> {
    throw new Error("DSH sessions ask no questions through Studio");
  }

  async attachInfo(): Promise<{ url: string; token: string; threadId: string }> {
    throw Object.assign(new Error("DSH 会话不能在终端打开"), { code: "bad_request" });
  }

  setWriter(sessionId: Id, writer: Session["writer"]): Session {
    return this.updateSession(sessionId, { writer });
  }

  /**
   * 设置 → 模型 →「检查」: starts DSH, initializes, opens a session in a scratch folder and closes it. No model call.
   * The result (and the models DSH offers) is kept.
   */
  async check(): Promise<DshCheck> {
    const path = readDshPath(this.store);
    const install = path ? describeDsh(path) : null;
    const at = this.now().toISOString();
    const result = (ok: boolean, message: string): DshCheck => {
      const c: DshCheck = { ok, at, message, version: install?.version ?? null, commit: install?.commit ?? null };
      this.store.setKv(DSH_CHECK_KEY, JSON.stringify(c));
      return c;
    };
    const unavailable = this.options.agent ? null : dshUnavailable(this.store);
    if (unavailable) return result(false, unavailable);
    const probe = join(this.options.dir, "probe");
    mkdirSync(probe, { recursive: true });
    let conn: AcpConnection | null = null;
    try {
      conn = this.spawn(probe, null, "workspace-write", "check");
      const init = await this.initialize(conn);
      const created = await conn.request<{ sessionId: string; configOptions?: ConfigOption[] }>("session/new", { cwd: probe, mcpServers: [] }, 60_000);
      this.remember(created.configOptions, null);
      await conn.request("session/close", { sessionId: created.sessionId }, 30_000).catch(() => undefined);
      const models = created.configOptions ? dshModels(created.configOptions).length : 0;
      return result(true, `可用 · ACP ${init.protocolVersion} · ${models} 个型号`);
    } catch (err) {
      return result(false, `不能用：${this.explain(err).message}`);
    } finally {
      await conn?.close(5_000);
    }
  }

  /** Host shutdown: every DSH process ends (its sessions resume on the next message). */
  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.live.keys()].map((id) => this.release(id)));
  }

  // ---- processes --------------------------------------------------------------------------------------------------

  private spawn(cwd: string, profile: ModelProfile | null, permission: DshPermissionMode, label: string): AcpConnection {
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env), [DSH_HOME_ENV]: join(this.options.dir, "home"), [DSH_PERMISSION_ENV]: permission };
    delete env.ELECTRON_RUN_AS_NODE;
    const credentialId = profile?.credentialId ?? this.options.profiles.find((p) => p.runtime === "dsh" && p.credentialId)?.credentialId;
    const key = credentialId ? this.options.credentials.read(credentialId) : null;
    if (key) env[DSH_KEY_ENV] = key;
    else if (profile?.credentialId) throw Object.assign(new Error(`还没有 DeepSeek 的 Key（凭据 ${profile.credentialId}）`), { code: "bad_request" });
    // A third-party channel: its address. (DSH reads it from the launch environment, which outranks a project's .env.)
    const baseUrl = profile?.provider ? this.options.providers?.[profile.provider]?.baseUrl : undefined;
    if (baseUrl) env[DSH_BASE_URL_ENV] = baseUrl;
    const patch = profile ? this.catalogPatch(profile) : null;
    let command: string;
    let args: string[];
    if (this.options.agent) {
      command = this.options.agent.command;
      args = [...this.options.agent.args];
    } else {
      const unavailable = dshUnavailable(this.store);
      if (unavailable) throw Object.assign(new Error(unavailable), { code: "bad_request" });
      const node = resolveNode(env);
      if (!node) throw Object.assign(new Error("找不到 Node（DSH 要用系统的 node 运行）"), { code: "bad_request" });
      command = node;
      args = [describeDsh(readDshPath(this.store)!)!.bin, ...DSH_ACP_ARGS];
    }
    if (patch) args.push("--patch", patch);
    const logFile = join(this.options.dir, "logs", `${label}.log`);
    return new AcpConnection({ command, args, cwd, env, logFile }, (method, params) => this.onRequest(method, params));
  }

  private async initialize(conn: AcpConnection): Promise<{ protocolVersion: number }> {
    const init = await conn.request<{ protocolVersion: number }>("initialize", { protocolVersion: ACP_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 120_000);
    if (init.protocolVersion !== ACP_VERSION) throw new Error(`DSH 说的是 ACP ${init.protocolVersion}，Studio 只会 ACP ${ACP_VERSION}`);
    return init;
  }

  /** The session's process, started and resumed when there is none. */
  private ensureLive(session: Session): Promise<Live> {
    const existing = this.live.get(session.id);
    if (existing?.conn.alive) return Promise.resolve(existing);
    const pending = this.starting.get(session.id);
    if (pending) return pending;
    const p = (async () => {
      if (!session.runtimeRef) throw new Error(`session ${session.id} has no DSH session`);
      const workspace = this.store.getWorkspace(session.workspaceId);
      if (!workspace) throw new Error(`workspace ${session.workspaceId} not found`);
      const permission = dshPermissionMode(session.options.permission);
      const conn = this.spawn(workspace.path, this.profile(session.profileId), permission, session.id);
      try {
        await this.initialize(conn);
        const token = this.options.identities?.tokenFor(session.id);
        const resumed = await conn.request<{ configOptions?: ConfigOption[] }>("session/resume", { sessionId: session.runtimeRef, cwd: workspace.path, mcpServers: this.mcpServers(token) });
        this.remember(resumed.configOptions, this.profile(session.profileId));
      } catch (err) {
        conn.kill();
        throw this.explain(err);
      }
      const live = this.adopt(session, conn, {}, permission);
      await this.applyOptions(session.id, live);
      return live;
    })().finally(() => this.starting.delete(session.id));
    this.starting.set(session.id, p);
    return p;
  }

  private adopt(session: Session, conn: AcpConnection, applied: Live["applied"], permission: DshPermissionMode): Live {
    const live: Live = { conn, acpId: session.runtimeRef!, permission, applied, inflight: false, queue: [], transcript: new DshTranscript(this.makeCore(), session.id, this.store.getWorkspace(session.workspaceId)?.path), waiting: new Map(), idleTimer: null, measuredAt: 0 };
    this.live.set(session.id, live);
    conn.on("notification", (method, params) => {
      if (method !== "session/update") return;
      const p = params as { sessionId?: string; update?: AcpUpdate };
      if (p.sessionId !== live.acpId || !p.update) return;
      live.transcript.update(p.update);
      // DSH could not set its sandbox up on the folder: the fix is offered.
      if (p.update.sessionUpdate === "tool_call_update" && p.update.status === "failed") {
        const failed = grantFailurePath(`${toolOutput(p.update.content)}\n${typeof p.update.rawOutput === "string" ? p.update.rawOutput : JSON.stringify(p.update.rawOutput ?? "")}`);
        if (failed) this.offerFolderFix(session.id, failed);
      }
      // A model call ended: now and then, the running turn's speed so far.
      if (p.update.sessionUpdate === "usage_update" && Date.now() - live.measuredAt >= MEASURE_EVERY_MS) this.measure(live, live.transcript.turnItemId());
    });
    conn.on("exit", (code) => {
      if (this.live.get(session.id) === live) this.live.delete(session.id);
      if (live.idleTimer) clearTimeout(live.idleTimer);
      if (!this.closing && live.inflight) this.emit("log", `DSH process of ${session.id} exited mid-turn (${code})`);
    });
    this.armIdle(session.id, live);
    // Before its first command: the folder's permissions let DSH set its write sandbox up.
    if (permission === "workspace-write") void this.checkFolder(session.id);
    return live;
  }

  // ---- the folder's permissions for DSH's write sandbox (folder-access.ts, 2026-10-23) ----------------------------

  private folderOf(sessionId: Id): string | undefined {
    const session = this.store.getSession(sessionId);
    return session ? this.store.getWorkspace(session.workspaceId)?.path : undefined;
  }

  private async checkFolder(sessionId: Id): Promise<void> {
    const path = this.folderOf(sessionId);
    if (!this.folderAccess || !path || this.folderNotices.has(sessionId)) return;
    let check = this.folderChecks.get(path);
    if (!check) this.folderChecks.set(path, (check = this.folderAccess.check(path)));
    const state = await check;
    if (state && !state.ok) this.offerFolderFix(sessionId, path);
  }

  /** The notice with 「修复文件夹权限」, once per session (DSH's error repeats on every command). */
  private offerFolderFix(sessionId: Id, failed: string): void {
    const path = this.folderOf(sessionId);
    // Only the session's own folder is fixed from here.
    if (!this.folderAccess || !path || path.toLowerCase() !== failed.toLowerCase()) return;
    const known = this.folderNotices.get(sessionId);
    const current = known ? this.store.getItem(known) : undefined;
    if (current?.type === "notice" && (current.action?.state === "offered" || current.action?.state === "running")) return;
    const body = { type: "notice" as const, level: "warning" as const, key: "folder-access", message: folderAccessMessage("offered", path), action: { kind: "folder-access" as const, path, state: "offered" as const } };
    if (current?.type === "notice") this.updateItem(current.id, (it) => (it.type === "notice" ? { ...it, ...body } : it));
    else this.folderNotices.set(sessionId, this.appendItem(sessionId, body, { method: "dsh/folder-access", ...(this.live.get(sessionId)?.transcript.turnRef() ?? {}) }).id);
  }

  /** 「修复文件夹权限」: gives the person inherited full control of the session's folder; the notice follows it. */
  async fixFolderAccess(sessionId: Id): Promise<void> {
    const path = this.folderOf(sessionId);
    const notice = [...this.store.listItems(sessionId)].reverse().find((i) => i.type === "notice" && i.action?.kind === "folder-access");
    if (!this.folderAccess || !path || notice?.type !== "notice" || notice.action?.path.toLowerCase() !== path.toLowerCase()) {
      throw Object.assign(new Error("这个会话没有要修的文件夹权限"), { code: "bad_request" });
    }
    if (notice.action.state === "running" || notice.action.state === "done") return;
    // Every session on this folder whose notice offers the fix follows the one fix.
    const notices = [notice.id, ...[...this.folderNotices.values()].filter((id) => id !== notice.id)].filter((id) => {
      const it = this.store.getItem(id);
      return it?.type === "notice" && it.action?.path.toLowerCase() === path.toLowerCase() && it.action.state !== "done";
    });
    const show = (state: "running" | "done" | "failed", extra = "") => {
      for (const id of notices)
        this.updateItem(id, (it) => (it.type === "notice" && it.action ? { ...it, level: state === "done" ? "info" : "warning", message: folderAccessMessage(state, path, extra), action: { ...it.action, state } } : it));
    };
    show("running");
    void this.folderAccess
      .fix(path)
      .then(({ state, backup }) => {
        this.folderChecks.set(path, Promise.resolve(state));
        if (state.ok) show("done", backup);
        else show("failed", `改过之后读回来，你对这个文件夹仍然没有可继承的完全控制（原来的权限备份在 ${backup}）`);
      })
      .catch((err: unknown) => {
        this.folderChecks.delete(path);
        show("failed", err instanceof Error ? err.message : String(err));
      });
  }

  /** Ends the session's process (when it is idle or archived, or for a new permission). */
  private async release(sessionId: Id): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    this.live.delete(sessionId);
    if (live.idleTimer) clearTimeout(live.idleTimer);
    for (const w of live.waiting.values()) this.settleWaiting(sessionId, live, w, "cancelled");
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

  private async prompt(sessionId: Id, live: Live, text: string): Promise<void> {
    live.inflight = true;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    await this.applyOptions(sessionId, live).catch((err: unknown) => this.emit("log", `dsh set options failed for ${sessionId}: ${String(err)}`));
    live.transcript.openTurn();
    this.setStatus(sessionId, "running");
    live.conn
      .request<{ stopReason?: string }>("session/prompt", { sessionId: live.acpId, prompt: [{ type: "text", text }] }, 0)
      .then(
        (r) => this.endTurn(sessionId, live, r.stopReason ?? "end_turn"),
        (err: unknown) => this.endTurn(sessionId, live, "error", this.explain(err).message),
      )
      .catch((err: unknown) => this.emit("log", `dsh turn end failed for ${sessionId}: ${String(err)}`));
  }

  private async endTurn(sessionId: Id, live: Live, stopReason: string, error?: string): Promise<void> {
    for (const w of live.waiting.values()) this.settleWaiting(sessionId, live, w, "cancelled");
    const turnItem = live.transcript.turnItemId();
    live.transcript.closeTurn(stopReason, error);
    // The turn's tokens and speed, from DSH's log; read again shortly in case its last lines were still being written.
    this.measure(live, turnItem);
    setTimeout(() => this.measure(live, turnItem), 2000).unref?.();
    live.inflight = false;
    if (error) {
      live.queue.splice(0);
      this.appendItem(sessionId, { type: "error", message: error }, { method: "session/prompt" });
      this.setStatus(sessionId, "error");
      this.armIdle(sessionId, live);
      return;
    }
    // A permission changed during the turn: its process ends now; the next message (or the queue) resumes it anew.
    const session = this.store.getSession(sessionId);
    if (session && live.permission !== dshPermissionMode(session.options.permission) && this.live.get(sessionId) === live) {
      const next = live.queue.splice(0).join("\n\n");
      await this.release(sessionId);
      if (!next) return this.setStatus(sessionId, "idle");
      const fresh = await this.ensureLive(session);
      await this.prompt(sessionId, fresh, next);
      return;
    }
    if (live.queue.length && live.conn.alive && this.live.get(sessionId) === live) {
      const next = live.queue.splice(0).join("\n\n");
      await this.prompt(sessionId, live, next);
      return;
    }
    this.setStatus(sessionId, "idle");
    this.armIdle(sessionId, live);
  }

  private async applyOptions(sessionId: Id, live: Live): Promise<void> {
    const session = this.store.getSession(sessionId);
    const opts = session?.options ?? {};
    const profile = (session && this.options.profiles.find((p) => p.id === session.profileId)) ?? null;
    // A channel with its own names: a model it does not list (picked before the list was set) stays on its default.
    const own = profile ? this.ownModels(profile) : null;
    const listed = !own || !opts.model || own.some((m) => `deepseek-official/${m}` === opts.model);
    if (opts.model && listed && opts.model !== live.applied.model) {
      const value = dshModelValue(opts.model, this.cachedOptions());
      const r = await live.conn.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", { sessionId: live.acpId, configId: DSH_MODEL_OPTION, value });
      live.applied.model = opts.model;
      this.remember(r.configOptions, profile);
    }
    if (opts.effort && opts.effort !== live.applied.effort) {
      const r = await live.conn.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", { sessionId: live.acpId, configId: DSH_EFFORT_OPTION, value: opts.effort });
      live.applied.effort = opts.effort;
      this.remember(r.configOptions, profile);
    }
  }

  /** A turn's tokens and speed from DSH's own session log (ACP tells only the context size). */
  private measure(live: Live, turnItem: Id | null): void {
    if (!turnItem) return;
    live.measuredAt = Date.now();
    try {
      const stats = dshTurnStats(join(this.options.dir, "home"), live.acpId);
      if (stats) live.transcript.applyStats(turnItem, stats);
    } catch (err) {
      this.emit("log", `dsh turn stats failed for ${live.acpId}: ${String(err)}`);
    }
  }

  // ---- approvals --------------------------------------------------------------------------------------------------

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== "session/request_permission") throw new AcpError(`Studio does not handle ${method}`, -32601);
    const p = params as { sessionId?: string; toolCall?: { toolCallId?: string; title?: string; rawInput?: unknown }; options?: Array<{ optionId: string; kind: string; name?: string }> };
    const entry = [...this.live.entries()].find(([, l]) => l.acpId === p.sessionId);
    if (!entry) return { outcome: { outcome: "cancelled" } };
    const [sessionId, live] = entry;
    const shown = live.transcript.approvalText(p.toolCall?.toolCallId, p.toolCall);
    const approvalId = newId("ap");
    // Switched to 完全访问 while this process still runs under its old sandbox: what it asks is granted at once.
    const allow = (p.options ?? []).find((o) => o.kind === DSH_ALLOW);
    if (allow && dshPermissionMode(this.store.getSession(sessionId)?.options.permission) === "danger-full-access") {
      this.appendItem(sessionId, { type: "approval", approvalId, kind: shown.kind, summary: shown.summary, detail: [shown.detail, "完全访问：Studio 已直接同意"].filter(Boolean).join(" · "), state: "accepted" }, { method, ...(p.toolCall?.toolCallId ? { itemId: p.toolCall.toolCallId } : {}), ...live.transcript.turnRef() });
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
    const kind = how === "allow" ? DSH_ALLOW : DSH_REJECT;
    const option = w.options.find((o) => o.kind === kind);
    w.answer(how === "cancelled" || !option ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: option.optionId } });
    this.updateItem(w.itemId, (it) => (it.type === "approval" && it.state === "pending" ? { ...it, state: how === "allow" ? "accepted" : "declined" } : it));
    if (!live.waiting.size && live.inflight && this.store.getSession(sessionId)?.status === "awaiting-approval") this.setStatus(sessionId, "running");
  }

  // ---- helpers ----------------------------------------------------------------------------------------------------

  private mcpServers(token: string | undefined): unknown[] {
    const mcp = this.options.mcp?.();
    if (!mcp || !token) return [];
    return [{ type: "http", name: "amo", url: mcp.url, headers: [{ name: "Authorization", value: `Bearer ${mcp.token}` }, { name: MCP_SESSION_HEADER, value: token }] }];
  }

  /** Keeps what DSH offers, for the pickers; not from a channel with its own catalog (that is not DSH's own list). */
  private remember(config: ConfigOption[] | undefined, profile: ModelProfile | null): void {
    if (config?.length && !(profile && this.ownModels(profile))) this.store.setKv(DSH_OPTIONS_KEY, JSON.stringify(config));
  }

  /** The site's own model names of a channel profile, or null (DSH's built-in catalog). */
  private ownModels(profile: ModelProfile): string[] | null {
    const models = profile.provider ? this.options.providers?.[profile.provider]?.models : undefined;
    return models?.length ? models : null;
  }

  /** A channel's catalog as a DSH patch file (written fresh for each process), or null when it has none. */
  private catalogPatch(profile: ModelProfile): string | null {
    const models = this.ownModels(profile);
    if (!models) return null;
    const own = profile.model?.replace(/^deepseek-official\//, "");
    const first = own && models.includes(own) ? own : models[0]!;
    const dir = join(this.options.dir, "patches");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${profile.provider}.yml`);
    writeFileSync(file, catalogPatchYaml(profile.label, models, first));
    return file;
  }

  private cachedOptions(): ConfigOption[] | null {
    try {
      const v = JSON.parse(this.store.getKv(DSH_OPTIONS_KEY)?.value ?? "null") as unknown;
      return Array.isArray(v) ? (v as ConfigOption[]) : null;
    } catch {
      return null;
    }
  }

  /** A readable error: DSH's own message, or what went wrong talking to it. */
  private explain(err: unknown): Error {
    if (err instanceof Error && (err as { code?: unknown }).code === "bad_request") return err;
    const message = err instanceof Error ? err.message : String(err);
    return Object.assign(new Error(message.startsWith("DSH") ? message : `DSH：${message}`), { code: "runtime_error" });
  }

  private profile(id: Id): ModelProfile {
    const p = this.options.profiles.find((x) => x.id === id);
    if (!p || p.runtime !== "dsh") throw new Error(`profile ${id} is not a DSH profile`);
    return p;
  }

  private writable(id: Id): Session {
    const s = this.requireSession(id);
    if (s.writer === "archived" || s.archivedAt) throw Object.assign(new Error("这个会话已归档"), { code: "read_only" });
    return s;
  }
}

/**
 * A DSH model value is a JSON route (`["deepseek-official","deepseek-v4-pro"]`); Studio's model id is the route
 * joined with "/" (`deepseek-official/deepseek-v4-pro`), which session options accept.
 */
export function dshModelId(value: string): string {
  try {
    const route = JSON.parse(value) as unknown;
    if (Array.isArray(route) && route.every((p) => typeof p === "string")) return route.join("/");
  } catch {
    // a plain value
  }
  return value;
}

/** The DSH value of a Studio model id: the offered value it stands for, else the route rebuilt from it. */
export function dshModelValue(id: string, config: readonly ConfigOption[] | null): string {
  const model = config?.find((c) => c.id === DSH_MODEL_OPTION);
  const offered = (model?.options ?? []).flatMap((o) => (o.options ? o.options.map((x) => x.value) : o.value ? [o.value] : []));
  // The route is the provider, then the model name, which may itself hold a "/" (a relay's `deepseek/deepseek-v4-pro`).
  const cut = id.indexOf("/");
  return offered.find((v) => dshModelId(v) === id) ?? (cut > 0 ? JSON.stringify([id.slice(0, cut), id.slice(cut + 1)]) : id);
}

/**
 * The DSH patch that makes a channel's model names DSH's catalog on its DeepSeek route (`llm-deepseek` has no config
 * of its own to lose) and `first` the ACP agent's default. Names are JSON-quoted, which YAML reads as strings.
 */
export function catalogPatchYaml(label: string, models: readonly string[], first: string): string {
  return [
    `# Written by AMO Studio for the channel ${JSON.stringify(label)}: the site's own model names. Rewritten on every start.`,
    "- id: llm-deepseek",
    "  config:",
    "    models:",
    ...models.map((m) => `      - id: ${JSON.stringify(m)}`),
    "- id: acp",
    "  config:",
    "    provider: deepseek-official",
    `    model: ${JSON.stringify(first)}`,
    "",
  ].join("\n");
}

/** A channel's own model names as Studio's models (`deepseek-official/<name>`), with the efforts DSH offers. */
export function channelModels(models: readonly string[], profileModel: string | null | undefined, config: readonly ConfigOption[] | null): ModelOption[] {
  const effort = config?.find((c) => c.id === DSH_EFFORT_OPTION);
  const efforts = (effort?.options ?? []).map((o) => o.value).filter((v): v is string => !!v);
  const ids = models.map((m) => `deepseek-official/${m}`);
  const def = profileModel && ids.includes(profileModel) ? profileModel : ids[0];
  return ids.map((id, i) => ({ id, label: models[i]!, efforts, ...(effort?.currentValue ? { defaultEffort: effort.currentValue } : {}), ...(id === def ? { isDefault: true } : {}) }));
}

/** DSH's model option as Studio's models; each gets the efforts DSH offers (it lists them for the current model). */
export function dshModels(config: readonly ConfigOption[]): ModelOption[] {
  const model = config.find((c) => c.id === DSH_MODEL_OPTION);
  const effort = config.find((c) => c.id === DSH_EFFORT_OPTION);
  const efforts = (effort?.options ?? []).map((o) => o.value).filter((v): v is string => !!v);
  const flat = (model?.options ?? []).flatMap((o) => (o.options ? o.options : o.value ? [{ value: o.value, name: o.name, description: o.description }] : []));
  return flat.map((o) => ({
    id: dshModelId(o.value),
    label: o.name ?? o.value,
    ...(o.description ? { description: o.description } : {}),
    efforts,
    ...(effort?.currentValue ? { defaultEffort: effort.currentValue } : {}),
    ...(o.value === model?.currentValue ? { isDefault: true } : {}),
  }));
}
