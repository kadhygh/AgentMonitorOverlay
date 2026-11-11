import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inTurn, type AccountUsage, type ApprovalDecision, type Attachment, type DshCheck, type FolderAccessStatus, type Id, type ModelOption, type ModelProfile, type ProfileChoices, type QuestionReply, type Session, type SessionOptions, type UserDelivery, type Workspace, type McpApply, type McpServerSpec } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";
import { newId } from "../../store/store.js";
import { MCP_SESSION_HEADER, type McpIdentities } from "../../mcp/identity.js";
import { DSH_DEFAULT_PERMISSION, DSH_PERMISSIONS, dshPermissionMode } from "../choices.js";
import type { CredentialReader } from "../credentials.js";
import { RuntimeBase, STOP_GRACE_MS, type SendMode, type SendOptions, type SessionRuntimeApi } from "../runtime.js";
import { withDelivery } from "../items.js";
import { AcpConnection, AcpError } from "./acp.js";
import { allTurnStats, dshLogText, dshTurnStats, type DshTurnStats } from "./session-log.js";
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
  DSH_ACCOUNT_DEFAULT_MODEL,
  DSH_ACCOUNT_OPTIONS_KEY,
  DSH_ACCOUNT_PROVIDER,
  DSH_KEY_PLUGIN,
  DSH_IMAGE_MODELS,
  DSH_IMAGE_MODEL_LABEL,
  accountPatchYaml,
  retryPatchYaml,
  retryPolicyYaml,
  dshAccountFile,
  dshAccountSignedIn,
  readDshAuth,
  resolveDsh,
  type DshPermissionMode,
} from "./install.js";

/** Starting a DeepSeek session that has no way to sign in (设置 → 模型 → DeepSeek). */
const ACCOUNT_SIGN_IN = "DSH 桌面版还没有登录 DeepSeek 账号：打开 DeepSeek Harness 桌面版登录，或者在 设置 → 模型 → DeepSeek 里改用 API Key";
const NO_KEY = "还没有 DeepSeek 的 API Key：在 设置 → 模型 → DeepSeek 里填上，或者改用 DSH 桌面版登录的账号";
import { blockText, DshTranscript, toolOutput, type AcpUpdate } from "./transcript.js";
import { DshSubagents } from "./subagents.js";
import { grantFailurePath, windowsFolderAccess, type FolderAccess, type FolderAccessState } from "./folder-access.js";
import { shellHelpEnv, withoutHostEnv } from "../agent-env.js";
import { acpServer, mcpFits, mcpSkippedNotice, type McpSkipped, type McpSource, type McpTransports } from "../mcp-launch.js";

// DeepSeek sessions on a DeepSeek Harness source clone (stage 17, plans/done/stage-17-dsh.md). Each session runs its own
// `node <clone>/apps/cli/lib/bin.js --profile acp` in its workspace: DSH's sandbox follows the process's working
// directory and its permission mode is the process's environment. Studio's DSH home (`<data>/dsh/home`) keeps DSH's
// own sessions; Studio keeps the conversation (DSH does not replay it on resume). What ACP lacks (spikes s17-00):
// fork, question cards, steering a running turn (a message sent meanwhile waits for the turn to end, `waiting`; 立即发送
// cancels the turn so it goes at once, 2026-11-04). Images go when
// the session's model takes them (2026-10-26: DSH tells at initialize, for the model its ACP agent starts on).

/** A third-party DeepSeek endpoint DSH can be pointed at (an Anthropic Messages root, like https://api.deepseek.com/anthropic). */
export interface DshProviderDef {
  baseUrl?: string;
  /**
   * The site's own model names (2026-10-19): given to DSH as its catalog (a `--patch` overlay), since DSH sends a
   * model's catalog id as is and a relay may know DeepSeek's models by other names (`deepseek/deepseek-v4-pro`).
   */
  models?: string[];
  /** Which of `models` take pictures (2026-11-11, the channel's 能看图); absent: DSH_IMAGE_MODELS among them. */
  imageModels?: string[];
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
  /** MCP 设置 (2026-11-04): the session's other MCP servers (Studio's and the person's that are on). */
  mcpServers?: McpSource;
  identities?: McpIdentities;
  /** 停止 not answered by DSH this long: Studio closes the session's process (default STOP_GRACE_MS). */
  stopGraceMs?: number;
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
  /** How long a set-up folder waits between scans after write turns (default AUTO_SCAN_MS; tests: 0). */
  folderScanEveryMs?: number;
  /** A turn DSH runs by itself ends this long after its last reply (default AUTO_QUIET_MS) … */
  autoQuietMs?: number;
  /** … or this long after anything else, when no command runs and nothing waits on the person (default AUTO_STALL_MS). */
  autoStallMs?: number;
  now?: () => Date;
}

/** The folder-access notice's words for each step of setting a folder up (`extra`: what the step adds). */
function folderAccessMessage(state: "offered" | "running" | "done" | "failed", path: string, extra = ""): string {
  switch (state) {
    case "offered":
      return extra === "full-control"
        ? `DSH 的「工作区可写」沙箱在「${path}」上设不起来：Windows 里你对这个文件夹没有可继承的「完全控制」权限（一般只有「修改」），沙箱要给它设的权限设不上，于是命令会一条条来要你批准，或者写不进里面已有的文件夹。「设置权限」会给你自己加上这个文件夹及其子文件夹的完全控制（原来的权限先备份），并处理好里面的 exe；沙箱的防护不变。不想管这些，把权限换成「完全访问」即可。`
        : `「${path}」还没为 DSH 的「工作区可写」沙箱设置过：沙箱会把整个项目标成低完整性，之后从项目里启动的 exe（工具、编译出来的程序）都会降级运行，写不了项目外。「设置权限」会把项目里的 exe 设回正常，之后构建出新的 exe 再扫一次即可。不想管这些，把权限换成「完全访问」即可。`;
    case "running":
      return `正在设置「${path}」的权限…文件多的项目要几分钟。`;
    case "done":
      return `「${path}」的权限已设置好，DSH 的「工作区可写」沙箱可以用了${extra}；刚才没跑成的命令让它再跑一次即可。`;
    case "failed":
      return `设置「${path}」的权限没成功：${extra}`;
  }
}

/** Studio's record of a folder it set up for DSH's write sandbox (kv `dsh-folder:<path, lower case>`). */
interface FolderRecord {
  setupAt: string;
  scannedAt: string;
  exes: number;
  backup?: string;
}

/** A set-up folder is scanned for new .exe files after a write session's turn, at most this often. */
const AUTO_SCAN_MS = 10 * 60_000;

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
  /**
   * Messages sent while a turn runs (their rows `waiting`), sent together when it ends — also after 停止, as Claude's
   * and Codex's are (2026-11-02, plans/done/send-now.md). An error, the process going or archiving makes them 没送到.
   */
  queue: QueuedMessage[];
  /** 停止 went unanswered and Studio closed the process: the turn ends as stopped, not as an error. */
  killedOnStop?: boolean;
  /** DSH said at initialize that this process takes images (for `model`, its ACP agent's default). */
  images: boolean;
  /** What the channel said takes pictures when the process started (imageKey). */
  imageKey: string;
  /** The session's model when the process started (its ACP agent's default); undefined = DSH's own default. */
  model: string | undefined;
  transcript: DshTranscript;
  waiting: Map<string, Waiting>;
  idleTimer: NodeJS.Timeout | null;
  /** When the running turn's speed was last read from DSH's log. */
  measuredAt: number;
  /** A turn DSH runs by itself, outside any prompt of Studio's (a goal's next round), and the timer that ends it. */
  auto: { timer: NodeJS.Timeout | null; stopping?: boolean } | null;
  /** MCP 设置 (2026-11-04): the other MCP servers the process was given (session/new or resume), to tell a change. */
  mcpKey: string;
}

interface QueuedMessage {
  itemId: Id;
  text: string;
  images: ImageBlock[];
}

/** An ACP inline image (prompt content). */
interface ImageBlock {
  type: "image";
  mimeType: string;
  data: string;
}

/** How often a running turn's speed is read again from DSH's log (on whatever update DSH sends next). */
const MEASURE_EVERY_MS = 15_000;
/** `logs/`: a log over LOG_MAX_BYTES is moved to `<label>.old.log` (the one before goes) when its process starts. */
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

export function rotateLog(file: string, max = LOG_MAX_BYTES): void {
  try {
    if (statSync(file).size > max) renameSync(file, file.replace(/\.log$/, ".old.log"));
  } catch {
    // No log yet, or held by a process still writing it: it goes on growing until the next start.
  }
}

/**
 * DSH's stderr logs (`logs/`, one file per process label; 2026-11-04, 架构整理第 6 步): a file not written for
 * LOG_KEEP_DAYS goes, and an empty one (most `new-*.log`) after a day. A deleted session's log is not written again, so
 * it goes the same way. DSH's own records in `home/` are DSH's and never touched.
 */
export function pruneDshLogs(dir: string, now = Date.now()): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".log")) continue;
    const file = join(dir, name);
    try {
      const st = statSync(file);
      const age = now - st.mtimeMs;
      if (age > LOG_KEEP_DAYS * DAY_MS || (st.size === 0 && age > DAY_MS)) {
        rmSync(file, { force: true });
        removed++;
      }
    } catch {
      // In use or gone: next start.
    }
  }
  return removed;
}

/** How far a turn in DSH's log may start from Studio's turn and still be taken for it (backfillStats). */
const BACKFILL_SLACK_MS = 5000;

/**
 * DSH tells over ACP neither when a turn it runs by itself starts nor when it ends (2026-11-03, 问题 #13): the quiet
 * after a reply that ends it (the user: 60 s; DSH sends a message only once its model call is written, so tens of
 * seconds between two updates are normal), and after anything else (a model call still thinking).
 */
const AUTO_QUIET_MS = 60_000;
const AUTO_STALL_MS = 10 * 60_000;
/** After 停止 on such a turn: it ends this long after DSH's last update. */
const AUTO_STOP_MS = 3000;

export class DshRuntime extends RuntimeBase implements SessionRuntimeApi {
  private readonly live = new Map<Id, Live>();
  /** Sessions whose process is being started or resumed. */
  private readonly starting = new Map<Id, Promise<Live>>();
  /** What each session was last told about MCP servers left out (said again only when it changes). */
  private readonly mcpTold = new Map<Id, string>();
  private closing = false;
  private readonly folderAccess: FolderAccess | null;
  /** Each session's folder-access notice in this run, and each folder's permissions as last read. */
  private readonly folderNotices = new Map<Id, Id>();
  private readonly folderChecks = new Map<string, Promise<FolderAccessState | null>>();
  /** The setup or scan on each folder (by lower-cased path) in this run: running, or how the last one went. */
  private readonly folderJobs = new Map<string, { job: "setup" | "scan" | "revert"; state: "running" | "done" | "failed"; error?: string }>();
  /** DSH's own subagents, from their logs (2026-11-06; ACP sends nothing of them). */
  private readonly subagents: DshSubagents;

  constructor(private readonly options: DshRuntimeOptions) {
    super(options.store, "dsh", options.now, options.profiles);
    this.subagents = new DshSubagents({ core: this.makeCore(), home: join(options.dir, "home"), turnRef: (id) => this.live.get(id)?.transcript.turnRef() ?? {} });
    this.folderAccess =
      options.folderAccess !== undefined ? options.folderAccess : options.agent || process.platform !== "win32" ? null : windowsFolderAccess(join(options.dir, "acl-backup"));
    // The last Host stopped mid-turn: the turn is over (its process went with the Host), and what waited for it was
    // never read (没送到).
    for (const s of this.store.listSessions()) {
      if (s.runtime !== "dsh" || !inTurn(s.status)) continue;
      this.settleLeftovers(s.id, { approvals: true });
      this.setStatus(s.id, "interrupted");
    }
  }

  // ---- operations -------------------------------------------------------------------------------------------------

  async startSession(input: { taskId: Id | null; topicId: Id | null; profileId: Id; workspace: Workspace; title?: string; text?: string; options?: SessionOptions }): Promise<Session> {
    const profile = this.profile(input.profileId);
    // A channel's own model when none was picked (DSH's catalog id, `deepseek-official/<model>`).
    const options = { ...(profile.model && !input.options?.model ? { model: profile.model } : {}), ...(input.options ?? {}) };
    const token = this.options.identities?.issue();
    const permission = dshPermissionMode(options.permission);
    const conn = this.spawn(input.workspace.path, profile, permission, `new-${Date.now()}`, options.model);
    const extra = this.extraMcp({ workspaceId: input.workspace.id, ...(options.mcp ? { mcp: options.mcp } : {}) });
    let session: Session;
    let image = false;
    let skipped: McpSkipped[] = [];
    try {
      const init = await this.initialize(conn);
      image = init.image;
      const fit = fitMcp(extra.specs, init.mcp);
      skipped = fit.skipped;
      const created = await withoutFailingMcp(fit, skipped, (list) => conn.request<{ sessionId: string; configOptions?: ConfigOption[] }>("session/new", { cwd: input.workspace.path, mcpServers: [...this.mcpServers(token), ...list] }));
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
    const live = this.adopt(session, conn, {}, permission, image, options.model);
    live.mcpKey = extra.key;
    this.tellSkippedMcp(session.id, skipped);
    await this.applyOptions(session.id, live);
    if (input.text) await this.sendMessage(session.id, input.text);
    return this.store.getSession(session.id)!;
  }

  async sendMessage(sessionId: Id, text: string, images: readonly Attachment[] = [], options: SendOptions = {}): Promise<{ mode: SendMode }> {
    const session = this.writable(sessionId);
    // Read the images first: a missing file fails the send before anything is shown or queued.
    const blocks = imageBlocks(images);
    if (!session.title) this.updateSession(sessionId, { title: (text || "图片").slice(0, 60) });
    const shown = images.map((a) => ({ id: a.id, path: a.path }));
    return this.deliver(session, blocks, text, options, (mode, live, delivery) => {
      const item = { type: "user" as const, text, ...(shown.length ? { images: shown } : {}), ...(delivery ? { delivery } : {}) };
      // Queued: shown in the running turn (as Claude's queued messages are), so that turn still reads as running.
      return this.appendItem(sessionId, item, mode === "queue" ? { method: "user/queued", ...live.transcript.turnRef() } : { method: "user" }).id;
    });
  }

  /**
   * One message into the session's process: a turn starts, or it waits for the running one to end (`waiting`). `item`
   * makes its row (or brings one back, for 重新发送 and Studio's inbox) and returns its id. `now` (立即发送 from the
   * composer, or B's): the running turn gives way to it (sendNow).
   */
  private async deliver(session: Session, blocks: ImageBlock[], text: string, options: SendOptions, item: (mode: SendMode, live: Live, delivery: UserDelivery | undefined) => Id): Promise<{ mode: SendMode }> {
    const sessionId = session.id;
    let live = await this.ensureLive(session);
    if (blocks.length) live = await this.takesImages(session, live);
    if (live.inflight) {
      const itemId = item("queue", live, "waiting");
      live.queue.push({ itemId, text, images: blocks });
      if (options.now === true) await this.sendNow(sessionId, itemId);
      return { mode: "queue" };
    }
    // DSH going on by itself: that turn ends here; DSH takes the message in when its step is done.
    if (live.auto) this.endAuto(sessionId, live, "end_turn", true);
    item("start", live, undefined);
    await this.prompt(sessionId, live, text, blocks);
    return { mode: "start" };
  }

  /**
   * 立即发送 on a waiting message (2026-11-04; ACP cannot steer a running turn): the turn is cancelled — DSH's own
   * cancel, as 停止 does, approvals waiting are cancelled with it — and the waiting messages go at once as the next turn.
   */
  async sendNow(sessionId: Id, itemId: Id): Promise<void> {
    this.writable(sessionId);
    const live = this.live.get(sessionId);
    if (!live?.inflight || !live.queue.some((q) => q.itemId === itemId)) return;
    for (const w of live.waiting.values()) this.settleWaiting(sessionId, live, w, "cancelled");
    live.conn.notify("session/cancel", { sessionId: live.acpId });
  }

  /** 重新发送 a message DSH never read (没送到), or one of Studio's inbox: the same row goes again, with its `images`. */
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

  /**
   * A message with pictures: DSH tells at initialize whether its ACP agent takes images, for the model the agent
   * starts on. When the session switched models since its process started, the process starts again on the new one
   * (between turns); a model that takes none is refused with its name.
   */
  private async takesImages(session: Session, live: Live): Promise<Live> {
    const model = session.options.model;
    const profile = this.profile(session.profileId);
    // The channel's 能看图 changed since the process started (2026-11-11): its catalog says so only from the next start.
    const stale = (model ?? "") !== (live.model ?? "") || this.imageKey(profile) !== live.imageKey;
    if (stale && !live.inflight && !live.auto) {
      await this.release(session.id);
      live = await this.ensureLive(this.requireSession(session.id));
    }
    if (live.images) return live;
    const own = this.ownModels(profile);
    const images = this.ownImages(profile);
    const takes = (id: string) => (own ? images.has(id.slice(id.indexOf("/") + 1)) : DSH_IMAGE_MODELS.has(id.slice(id.indexOf("/") + 1)));
    throw Object.assign(new Error(noImagesMessage(profile, this.pickable(profile), model, (model ?? "") !== (live.model ?? ""), takes)), { code: "bad_request" });
  }

  /** What the channel says takes pictures, to tell when a process started before it changed. */
  private imageKey(profile: ModelProfile | null): string {
    return profile && this.ownModels(profile) ? [...this.ownImages(profile)].join("\n") : "";
  }

  /** The models the session's picker offers on `profile` (as `choices` lists them), from what is known now. */
  private pickable(profile: ModelProfile): ModelOption[] {
    const config = this.cachedOptions(profile);
    const own = this.ownModels(profile);
    return own ? channelModels(own, profile.model, config) : config ? this.modelsOf(profile, config) : [];
  }

  async choices(profileId: Id): Promise<ProfileChoices> {
    const profile = this.profile(profileId);
    let config = this.cachedOptions(profile);
    if (!config) {
      // Asked on this profile's own sign-in (a third-party channel's key, or the built-in one's account or key).
      await this.probe(profile).catch(() => undefined);
      config = this.cachedOptions(profile);
    }
    const base = { profileId, permissions: DSH_PERMISSIONS, defaultPermission: DSH_DEFAULT_PERMISSION };
    // A channel with its own model names: those (the efforts are DSH's).
    const own = this.ownModels(profile);
    if (own) return { ...base, models: channelModels(own, profile.model, config), source: "builtin" };
    return { ...base, models: config ? this.modelsOf(profile, config) : [], source: config ? "cli" : "builtin" };
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
    // Not while DSH goes on by itself either: a restart would cut it off (it restarts when that turn ends).
    if (!live.inflight && !live.auto) {
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
    // A turn DSH runs by itself: session/cancel without a prompt stops DSH's own work (its ACP cancel()). The turn
    // ends shortly after DSH's last update, so what it still sends while stopping stays in it.
    if (live?.auto && !live.inflight) {
      for (const w of live.waiting.values()) this.settleWaiting(sessionId, live, w, "cancelled");
      live.conn.notify("session/cancel", { sessionId: live.acpId });
      live.auto.stopping = true;
      this.armAutoEnd(sessionId, live);
      return;
    }
    if (!live?.inflight) return;
    // What waits for the turn goes on after it, as with Claude and Codex (the user, 2026-11-02: 停止 sends what waits).
    for (const w of live.waiting.values()) this.settleWaiting(sessionId, live, w, "cancelled");
    live.conn.notify("session/cancel", { sessionId: live.acpId });
    // 停止's fallback (2026-11-04): a DSH stuck in a command or a model call that does not end the prompt has its
    // process closed; what waited for the turn becomes 没送到 (a process that had to be killed may be stuck again).
    const grace = this.options.stopGraceMs ?? STOP_GRACE_MS;
    // Only the prompt that was stopped (2026-11-09: with Claude, a message sent right after a quick 停止 had its new turn
    // cut 15 s after 停止; DSH's process lives on between prompts the same way).
    const turnId = live.transcript.turnRef().turnId;
    this.armStopGrace(sessionId, grace, () => this.live.get(sessionId) === live && live.inflight && live.transcript.turnRef().turnId === turnId, () => {
      live.killedOnStop = true;
      this.appendItem(sessionId, { type: "notice", level: "warning", message: `点了停止 ${Math.round(grace / 1000)} 秒后 DSH 还没停下（它可能卡在某个命令上），Studio 关掉了它的进程。发一条消息即可接着对话。` }, { method: "dsh/stop", ...live.transcript.turnRef() });
      live.conn.kill();
    }, "closing its process");
  }

  async fork(): Promise<Session> {
    throw Object.assign(new Error("DSH 会话不能分支（DSH 的 ACP 不支持 fork）"), { code: "bad_request" });
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
    const resolved = this.options.agent ? null : resolveDsh(this.store);
    const launch = resolved && !("error" in resolved) ? resolved : null;
    const at = this.now().toISOString();
    const result = (ok: boolean, message: string): DshCheck => {
      const c: DshCheck = { ok, at, message, version: launch?.version ?? null, commit: launch?.commit ?? null, ...(launch ? { kind: launch.kind } : {}) };
      this.store.setKv(DSH_CHECK_KEY, JSON.stringify(c));
      return c;
    };
    if (resolved && "error" in resolved) return result(false, resolved.error);
    try {
      const { protocolVersion, models } = await this.probe(null);
      const how = this.usesAccount(null) ? " · 用桌面版登录的 DeepSeek 账号" : "";
      return result(true, `可用 · ACP ${protocolVersion} · ${models} 个型号${how}`);
    } catch (err) {
      return result(false, `不能用：${this.explain(err).message}`);
    }
  }

  /** Starts DSH for `profile` (null: the built-in one) and opens a session, no model call; keeps the models it offers. */
  private async probe(profile: ModelProfile | null): Promise<{ protocolVersion: number; models: number }> {
    const probe = join(this.options.dir, "probe");
    mkdirSync(probe, { recursive: true });
    let conn: AcpConnection | null = null;
    try {
      conn = this.spawn(probe, profile, "workspace-write", "check");
      const init = await this.initialize(conn);
      const created = await conn.request<{ sessionId: string; configOptions?: ConfigOption[] }>("session/new", { cwd: probe, mcpServers: [] }, 60_000);
      this.remember(created.configOptions, profile);
      await conn.request("session/close", { sessionId: created.sessionId }, 30_000).catch(() => undefined);
      return { protocolVersion: init.protocolVersion, models: created.configOptions ? this.modelsOf(profile, created.configOptions).length : 0 };
    } finally {
      await conn?.close(5_000);
    }
  }

  /** Host shutdown: every DSH process ends (its sessions resume on the next message). */
  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.live.keys()].map((id) => this.release(id)));
    this.subagents.close();
  }

  /** A DSH subagent's session is shown from DSH's log: its parent talks to it (DSH's send_message). */
  protected override writable(id: Id): Session {
    const s = super.writable(id);
    if (s.kind === "sub") throw Object.assign(new Error("DSH 的子 agent 不能单独接收消息，请在父会话里继续"), { code: "read_only" });
    return s;
  }

  // ---- processes --------------------------------------------------------------------------------------------------

  private spawn(cwd: string, profile: ModelProfile | null, permission: DshPermissionMode, label: string, model?: string): AcpConnection {
    const env: NodeJS.ProcessEnv = { ...shellHelpEnv(this.store), ...withoutHostEnv(this.options.env ?? process.env), [DSH_HOME_ENV]: join(this.options.dir, "home"), [DSH_PERMISSION_ENV]: permission };
    // A model of the other sign-in (picked before 设置 changed it) is not asked for: the agent starts on its default.
    const usable = model && this.routeAllowed(profile, model) ? model : undefined;
    let patch: string | null;
    if (this.usesAccount(profile)) {
      // The DSH desktop app's DeepSeek account (2026-11-03): its credentials file, no key.
      const file = dshAccountFile(this.options.env ?? process.env);
      if (!dshAccountSignedIn(file)) throw Object.assign(new Error(ACCOUNT_SIGN_IN), { code: "bad_request" });
      patch = this.accountPatch(file, usable);
    } else {
      const credentialId = this.credentialOf(profile);
      const key = credentialId ? this.options.credentials.read(credentialId) : null;
      if (key) env[DSH_KEY_ENV] = key;
      else if (profile?.credentialId) throw Object.assign(new Error(profile.custom ? `这个渠道还没有 Key（设置 → 模型 →「${profile.label}」→ 编辑）` : NO_KEY), { code: "bad_request" });
      // A third-party channel: its address. (DSH reads it from the launch environment, which outranks a project's .env.)
      const baseUrl = profile?.provider ? this.options.providers?.[profile.provider]?.baseUrl : undefined;
      if (baseUrl) env[DSH_BASE_URL_ENV] = baseUrl;
      patch = (profile ? (this.catalogPatch(profile, usable) ?? (usable ? this.modelPatch(usable) : null)) : null) ?? this.retryPatch();
    }
    let command: string;
    let args: string[];
    if (this.options.agent) {
      command = this.options.agent.command;
      args = [...this.options.agent.args];
    } else {
      const launch = resolveDsh(this.store, env);
      if ("error" in launch) throw Object.assign(new Error(launch.error), { code: "bad_request" });
      command = launch.command;
      args = [...launch.args, ...DSH_ACP_ARGS];
      Object.assign(env, launch.env);
    }
    if (patch) args.push("--patch", patch);
    const logFile = join(this.options.dir, "logs", `${label}.log`);
    rotateLog(logFile);
    return new AcpConnection({ command, args, cwd, env, logFile }, (method, params) => this.onRequest(method, params));
  }

  /**
   * ACP's handshake; `image`: whether the agent takes inline images (for the model it starts on); `mcp`: the MCP
   * connections it takes besides stdio (2026-11-09: DSH says http only, and refuses a whole session/new with an SSE one).
   */
  private async initialize(conn: AcpConnection): Promise<{ protocolVersion: number; image: boolean; mcp: McpTransports }> {
    const init = await conn.request<{ protocolVersion: number; agentCapabilities?: { promptCapabilities?: { image?: boolean }; mcpCapabilities?: { http?: boolean; sse?: boolean } } }>("initialize", { protocolVersion: ACP_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 120_000);
    if (init.protocolVersion !== ACP_VERSION) throw new Error(`DSH 说的是 ACP ${init.protocolVersion}，Studio 只会 ACP ${ACP_VERSION}`);
    const mcp = init.agentCapabilities?.mcpCapabilities;
    return { protocolVersion: init.protocolVersion, image: init.agentCapabilities?.promptCapabilities?.image === true, mcp: { http: mcp?.http === true, sse: mcp?.sse === true } };
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
      const conn = this.spawn(workspace.path, this.profile(session.profileId), permission, session.id, session.options.model);
      let image = false;
      const extra = this.extraMcp(session.id);
      let skipped: McpSkipped[] = [];
      try {
        const init = await this.initialize(conn);
        image = init.image;
        const fit = fitMcp(extra.specs, init.mcp);
        skipped = fit.skipped;
        const token = this.options.identities?.tokenFor(session.id);
        const resumed = await withoutFailingMcp(fit, skipped, (list) => conn.request<{ configOptions?: ConfigOption[] }>("session/resume", { sessionId: session.runtimeRef, cwd: workspace.path, mcpServers: [...this.mcpServers(token), ...list] }));
        this.remember(resumed.configOptions, this.profile(session.profileId));
      } catch (err) {
        conn.kill();
        throw this.explain(err);
      }
      const live = this.adopt(session, conn, {}, permission, image, session.options.model);
      live.mcpKey = extra.key;
      this.tellSkippedMcp(session.id, skipped);
      await this.applyOptions(session.id, live);
      return live;
    })().finally(() => this.starting.delete(session.id));
    this.starting.set(session.id, p);
    return p;
  }

  private adopt(session: Session, conn: AcpConnection, applied: Live["applied"], permission: DshPermissionMode, images: boolean, model: string | undefined): Live {
    const live: Live = { conn, acpId: session.runtimeRef!, permission, applied, inflight: false, queue: [], images, imageKey: this.imageKey(this.options.profiles.find((p) => p.id === session.profileId) ?? null), model, transcript: new DshTranscript(this.makeCore(), session.id, this.store.getWorkspace(session.workspaceId)?.path, this.subagents), waiting: new Map(), idleTimer: null, measuredAt: 0, auto: null, mcpKey: "" };
    this.live.set(session.id, live);
    conn.on("notification", (method, params) => {
      if (method !== "session/update") return;
      const p = params as { sessionId?: string; update?: AcpUpdate };
      if (p.sessionId !== live.acpId || !p.update) return;
      if (!live.inflight) this.autonomous(session.id, live, p.update);
      live.transcript.update(p.update);
      if (live.auto) this.armAutoEnd(session.id, live);
      // DSH could not set its sandbox up on the folder: the fix is offered.
      if (p.update.sessionUpdate === "tool_call_update" && p.update.status === "failed") {
        const failed = grantFailurePath(`${toolOutput(p.update.content)}\n${typeof p.update.rawOutput === "string" ? p.update.rawOutput : JSON.stringify(p.update.rawOutput ?? "")}`);
        if (failed) this.offerFolderFix(session.id, failed);
      }
      // Now and then while a turn runs, its speed so far. 2026-10-27: on any update, not only usage_update — DSH sends
      // that about once a turn, at its start (the log still empty), so a long turn showed no speed until it ended.
      if ((live.inflight || live.auto) && Date.now() - live.measuredAt >= MEASURE_EVERY_MS) this.measure(live, live.transcript.turnItemId());
    });
    conn.on("exit", (code) => {
      if (this.live.get(session.id) === live) this.live.delete(session.id);
      // Its subagents ran in this process: what they last wrote is read, those still running stopped with it.
      this.subagents.stopTree(session.id);
      if (live.idleTimer) clearTimeout(live.idleTimer);
      if (!this.closing && live.inflight) this.emit("log", `DSH process of ${session.id} exited mid-turn (${code})`);
      // A turn DSH ran by itself is cut off with its process (a Host shutdown leaves it to the next start).
      if (!this.closing && live.auto) this.endAuto(session.id, live, "cancelled");
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
    if (state && (!state.ok || !this.folderRecord(path))) this.offerFolderFix(sessionId, path, state.ok ? "label" : "full-control");
  }

  /** The notice with 「修复文件夹权限」, once per session (DSH's error repeats on every command). */
  private offerFolderFix(sessionId: Id, failed: string, why: "full-control" | "label" = "full-control"): void {
    const path = this.folderOf(sessionId);
    // Only the session's own folder is fixed from here.
    if (!this.folderAccess || !path || path.toLowerCase() !== failed.toLowerCase()) return;
    const known = this.folderNotices.get(sessionId);
    const current = known ? this.store.getItem(known) : undefined;
    if (current?.type === "notice" && (current.action?.state === "offered" || current.action?.state === "running")) return;
    const body = { type: "notice" as const, level: "warning" as const, key: "folder-access", message: folderAccessMessage("offered", path, why), action: { kind: "folder-access" as const, path, state: "offered" as const } };
    if (current?.type === "notice") this.updateItem(current.id, (it) => (it.type === "notice" ? { ...it, ...body } : it));
    else this.folderNotices.set(sessionId, this.appendItem(sessionId, body, { method: "dsh/folder-access", ...(this.live.get(sessionId)?.transcript.turnRef() ?? {}) }).id);
  }

  /** 「设置权限」 on a session's notice: sets the session's folder up (setupFolder). */
  async fixFolderAccess(sessionId: Id): Promise<void> {
    const path = this.folderOf(sessionId);
    const notice = [...this.store.listItems(sessionId)].reverse().find((i) => i.type === "notice" && i.action?.kind === "folder-access");
    if (!this.folderAccess || !path || notice?.type !== "notice" || notice.action?.path.toLowerCase() !== path.toLowerCase()) {
      throw Object.assign(new Error("这个会话没有要修的文件夹权限"), { code: "bad_request" });
    }
    if (notice.action.state === "running" || notice.action.state === "done") return;
    if (!this.folderNotices.has(sessionId)) this.folderNotices.set(sessionId, notice.id);
    this.setupFolder(path);
  }

  /** Whether folders can be read and set up here (Windows). */
  get foldersAvailable(): boolean {
    return this.folderAccess !== null;
  }

  private folderRecord(path: string): FolderRecord | null {
    const kv = this.store.getKv(`dsh-folder:${path.toLowerCase()}`);
    if (!kv) return null;
    try {
      return JSON.parse(kv.value) as FolderRecord;
    } catch {
      return null;
    }
  }

  /** A folder as DSH's write sandbox needs it, or the setup or scan running or failed on it (FolderAccessStatus). */
  async folderStatus(path: string): Promise<Omit<FolderAccessStatus, "workspaceId" | "name" | "path">> {
    const job = this.folderJobs.get(path.toLowerCase());
    const record = this.folderRecord(path);
    const last = record ? { exes: record.exes, scannedAt: record.scannedAt, ...(record.backup ? { backup: record.backup } : {}) } : {};
    if (job?.state === "running") return { state: "running", job: job.job, ...last };
    if (!this.folderAccess) return { state: "unknown", ...last };
    // Read anew each time it is asked: the person may have changed them by hand.
    const check = this.folderAccess.check(path);
    this.folderChecks.set(path, check);
    const state = await check;
    const read = state ? { fullControl: state.ok, labelled: state.labelled } : {};
    if (job?.state === "failed") return { state: "failed", job: job.job, ...(job.error ? { error: job.error } : {}), ...read, ...last };
    return { state: !state ? "unknown" : state.ok && record ? "ready" : "unprepared", ...read, ...last };
  }

  /** Runs a setup or a scan on a folder, once at a time; the sessions on it whose notice offers the setup follow it. */
  private folderJob(path: string, job: "setup" | "scan" | "revert", work: (fa: FolderAccess) => Promise<string>): void {
    const fa = this.folderAccess;
    if (!fa) throw Object.assign(new Error("这台机器上 Studio 不处理文件夹权限（只在 Windows 上）"), { code: "bad_request" });
    const key = path.toLowerCase();
    if (this.folderJobs.get(key)?.state === "running") return;
    this.folderJobs.set(key, { job, state: "running" });
    const show = (state: "running" | "done" | "failed", extra = "") => {
      for (const id of this.folderNotices.values()) {
        const it = this.store.getItem(id);
        if (it?.type !== "notice" || it.action?.path.toLowerCase() !== key || it.action.state === "done") continue;
        this.updateItem(id, (x) => (x.type === "notice" && x.action ? { ...x, level: state === "done" ? "info" : "warning", message: folderAccessMessage(state, path, extra), action: { ...x.action, state } } : x));
      }
    };
    if (job === "setup") show("running");
    void work(fa)
      .then((done) => {
        this.folderJobs.set(key, { job, state: "done" });
        if (job === "setup") show("done", done);
      })
      .catch((err: unknown) => {
        this.folderChecks.delete(path);
        const error = err instanceof Error ? err.message : String(err);
        this.folderJobs.set(key, { job, state: "failed", error });
        if (job === "setup") show("failed", error);
        else this.emit("log", `dsh folder scan failed for ${path}: ${error}`);
      });
  }

  /**
   * Sets a folder up for DSH's write sandbox (folder-access.ts): the person's inherited full control (old permissions
   * saved first) when missing, DSH's Low label passed on, and every .exe back to Medium.
   */
  setupFolder(path: string): void {
    this.folderJob(path, "setup", async (fa) => {
      const before = await fa.check(path);
      if (!before) throw new Error(`读不到「${path}」的权限`);
      const backup = before.ok ? undefined : await fa.grant(path);
      // Just granted, the label DSH may have set on the folder alone can now reach what is in it.
      if (backup || !before.labelled) await fa.label(path);
      const exes = await fa.exes(path);
      const after = await fa.check(path);
      this.folderChecks.set(path, Promise.resolve(after));
      if (!after?.ok) throw new Error(`改过之后读回来，你对这个文件夹仍然没有可继承的完全控制${backup ? `（原来的权限备份在 ${backup}）` : ""}`);
      const at = new Date().toISOString();
      const old = this.folderRecord(path);
      const keep = backup ?? old?.backup;
      this.store.setKv(`dsh-folder:${path.toLowerCase()}`, JSON.stringify({ setupAt: at, scannedAt: at, exes, ...(keep ? { backup: keep } : {}) } satisfies FolderRecord));
      return `${exes ? `，项目里的 ${exes} 个 exe 已设回正常` : ""}${backup ? `。原来的权限备份在 ${backup}（在上一级文件夹里用 icacls /restore 可以放回去）` : ""}`;
    });
  }

  /**
   * 恢复原来的权限 (2026-10-26): undoes the setup (FolderAccess.revert) — DSH's sandbox entries and the Low label go,
   * and the full control Studio granted (when its backup says it did). The folder is no longer set up. A 工作区可写
   * session in it later sets DSH's own entry and label again.
   */
  revertFolder(path: string): void {
    const record = this.folderRecord(path);
    this.folderJob(path, "revert", async (fa) => {
      const backup = await fa.revert(path, !!record?.backup);
      this.store.setKv(`dsh-folder:${path.toLowerCase()}`, "");
      return backup;
    });
  }

  /** Scans a set-up folder for .exe files again (new ones from a build or a pull) and sets them back to Medium. */
  scanFolder(path: string): void {
    const record = this.folderRecord(path);
    if (!record) throw Object.assign(new Error("这个项目还没设置过权限，先「设置权限」"), { code: "bad_request" });
    this.folderJob(path, "scan", async (fa) => {
      const exes = await fa.exes(path);
      this.store.setKv(`dsh-folder:${path.toLowerCase()}`, JSON.stringify({ ...(this.folderRecord(path) ?? record), scannedAt: new Date().toISOString(), exes } satisfies FolderRecord));
      return "";
    });
  }

  /** After a write session's turn: a set-up folder not scanned for a while is scanned again (new .exe files). */
  private autoScan(sessionId: Id, live: Live): void {
    const path = this.folderOf(sessionId);
    if (!this.folderAccess || !path || live.permission !== "workspace-write") return;
    const record = this.folderRecord(path);
    if (!record || Date.now() - Date.parse(record.scannedAt) < (this.options.folderScanEveryMs ?? AUTO_SCAN_MS)) return;
    try {
      this.scanFolder(path);
    } catch {
      // Not set up after all: nothing to scan.
    }
  }

  /** Ends the session's process (when it is idle or archived, or for a new permission). */
  private async release(sessionId: Id): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    this.live.delete(sessionId);
    if (live.idleTimer) clearTimeout(live.idleTimer);
    for (const w of live.waiting.values()) this.settleWaiting(sessionId, live, w, "cancelled");
    // Archived or the Host closing mid-turn: what waited for the turn goes with the process.
    this.unsent(live);
    if (live.conn.alive) {
      await live.conn.request("session/close", { sessionId: live.acpId }, 15_000).catch(() => undefined);
      await live.conn.close();
    }
  }

  private armIdle(sessionId: Id, live: Live): void {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
    if (live.inflight || live.auto) return;
    live.idleTimer = setTimeout(() => {
      if (!live.inflight && !live.auto && this.live.get(sessionId) === live) void this.release(sessionId);
    }, this.options.idleMs ?? 20 * 60_000);
    live.idleTimer.unref();
  }

  // ---- turns ------------------------------------------------------------------------------------------------------

  private async prompt(sessionId: Id, live: Live, text: string, images: readonly ImageBlock[] = [], sent: readonly Id[] = []): Promise<void> {
    live.inflight = true;
    live.killedOnStop = false;
    // Queued messages going now: on their way to the model.
    for (const id of sent) this.updateItem(id, (it) => (it.type === "user" ? withDelivery(it, undefined) : it));
    if (live.idleTimer) clearTimeout(live.idleTimer);
    await this.applyOptions(sessionId, live).catch((err: unknown) => this.emit("log", `dsh set options failed for ${sessionId}: ${String(err)}`));
    live.transcript.openTurn();
    this.setStatus(sessionId, "running");
    live.conn
      .request<{ stopReason?: string }>("session/prompt", { sessionId: live.acpId, prompt: [...(text ? [{ type: "text", text }] : []), ...images] }, 0)
      .then(
        (r) => this.endTurn(sessionId, live, r.stopReason ?? "end_turn"),
        (err: unknown) => this.endTurn(sessionId, live, "error", this.explain(err).message),
      )
      .catch((err: unknown) => this.emit("log", `dsh turn end failed for ${sessionId}: ${String(err)}`));
  }

  private async endTurn(sessionId: Id, live: Live, stopReason: string, error?: string): Promise<void> {
    // The Host is closing: the turn is cut off, not failed — the next start settles it (and its waiting messages were
    // marked 没送到 by release).
    if (this.closing) return;
    // Closed after 停止 went unanswered (interrupt): a stopped turn, not an error.
    if (error && live.killedOnStop) {
      stopReason = "cancelled";
      error = undefined;
    }
    for (const w of live.waiting.values()) this.settleWaiting(sessionId, live, w, "cancelled");
    const turnItem = live.transcript.turnItemId();
    live.transcript.closeTurn(stopReason, error);
    // The turn's tokens and speed, from DSH's log; read again shortly in case its last lines were still being written.
    this.measure(live, turnItem);
    setTimeout(() => this.measure(live, turnItem), 2000).unref?.();
    live.inflight = false;
    this.autoScan(sessionId, live);
    if (error) {
      // 2026-11-04: they were dropped unseen; now 没送到, sent again by the person (重新发送).
      this.unsent(live);
      this.appendItem(sessionId, { type: "error", message: error }, { method: "session/prompt" });
      this.setStatus(sessionId, "error");
      this.armIdle(sessionId, live);
      return;
    }
    // A permission changed during the turn: its process ends now; the next message (or the queue) resumes it anew.
    const session = this.store.getSession(sessionId);
    // So did its MCP servers (MCP 设置): DSH takes them only at session/new or resume.
    if (session && (live.permission !== dshPermissionMode(session.options.permission) || this.mcpChanged(sessionId, live)) && this.live.get(sessionId) === live) {
      const queued = live.queue.splice(0);
      await this.release(sessionId);
      if (!queued.length) return this.setStatus(sessionId, "idle");
      try {
        const fresh = await this.ensureLive(session);
        fresh.queue.push(...queued);
        const next = takeQueue(fresh)!;
        await this.prompt(sessionId, fresh, next.text, next.images, next.items);
      } catch (err) {
        // The new process did not come up: the messages are 没送到 and the session says why.
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
    // The process went (or was replaced) with messages still waiting: never read.
    this.unsent(live);
    this.setStatus(sessionId, "idle");
    this.armIdle(sessionId, live);
  }

  /** Messages waiting for the turn that this process will never send: 没送到 (重新发送 sends them again). */
  private unsent(live: Live): void {
    for (const q of live.queue.splice(0)) this.updateItem(q.itemId, (it) => (it.type === "user" && it.delivery === "waiting" ? withDelivery(it, "unsent") : it));
  }

  /**
   * DSH works with no prompt of Studio's running (2026-11-03, 问题 #13): a goal's next round starts by itself once the
   * turn before has ended. Before, those rows had no turn: the turn before kept them, its answer folded away with the
   * work after it, the session read as idle (no 停止, nothing in Focus) and its process was closed after the idle time
   * mid-goal. Now each such round is a turn: one opens on DSH's first update with none running; a reply followed
   * straight by a new model call (no tool between; a DSH turn ends on a message without tool calls) ends it and opens
   * the next; the last ends after a quiet spell (armAutoEnd), on the person's next message, 停止, or the process ending.
   */
  private autonomous(sessionId: Id, live: Live, u: AcpUpdate): void {
    const work = ((u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk") && !!blockText(u.content)) || (u.sessionUpdate === "tool_call" && !!u.toolCallId);
    if (!work) return;
    if (live.auto && !live.auto.stopping && live.transcript.endsRound(u)) this.endAuto(sessionId, live, "end_turn", true);
    if (live.auto) return;
    live.auto = { timer: null };
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
    live.transcript.openTurn();
    this.setStatus(sessionId, "running");
  }

  /** When a turn DSH runs by itself is taken to be over, from its latest update on. */
  private armAutoEnd(sessionId: Id, live: Live): void {
    const auto = live.auto;
    if (!auto) return;
    if (auto.timer) clearTimeout(auto.timer);
    const ms = auto.stopping ? AUTO_STOP_MS : live.transcript.lastWasReply() ? (this.options.autoQuietMs ?? AUTO_QUIET_MS) : (this.options.autoStallMs ?? AUTO_STALL_MS);
    auto.timer = setTimeout(() => {
      if (live.auto !== auto) return;
      // A command still running or a question to the person: not over (their own updates arm this again).
      if (!auto.stopping && (live.waiting.size || live.transcript.toolsRunning())) return void this.armAutoEnd(sessionId, live);
      this.endAuto(sessionId, live, auto.stopping ? "cancelled" : "end_turn");
    }, ms);
    auto.timer.unref?.();
  }

  /** Ends the turn DSH ran by itself; `next`: another turn (DSH's next round, or the person's message) follows at once. */
  private endAuto(sessionId: Id, live: Live, stopReason: string, next = false): void {
    const auto = live.auto;
    if (!auto) return;
    if (auto.timer) clearTimeout(auto.timer);
    live.auto = null;
    const turnItem = live.transcript.turnItemId();
    live.transcript.closeTurn(stopReason);
    this.measure(live, turnItem);
    setTimeout(() => this.measure(live, turnItem), 2000).unref?.();
    if (next) return;
    // Idle after 停止 too, as after a stopped turn of Studio's (the turn itself says 已停止).
    this.setStatus(sessionId, "idle");
    if (this.live.get(sessionId) !== live) return;
    // A permission changed meanwhile: the process ends now (as after a turn of Studio's).
    const session = this.store.getSession(sessionId);
    if (session && live.permission !== dshPermissionMode(session.options.permission)) return void this.release(sessionId);
    this.armIdle(sessionId, live);
  }

  private async applyOptions(sessionId: Id, live: Live): Promise<void> {
    const session = this.store.getSession(sessionId);
    const opts = session?.options ?? {};
    const profile = (session && this.options.profiles.find((p) => p.id === session.profileId)) ?? null;
    // A channel with its own names: a model it does not list (picked before the list was set) stays on its default.
    const own = profile ? this.ownModels(profile) : null;
    const listed = !own || !opts.model || own.some((m) => `deepseek-official/${m}` === opts.model);
    // A model of the other sign-in (picked before 设置 changed it, 2026-11-03) stays on the default too.
    if (opts.model && listed && this.routeAllowed(profile, opts.model) && opts.model !== live.applied.model) {
      const value = dshModelValue(opts.model, this.cachedOptions(profile));
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

  /** `logs/` was never cleaned (2026-11-04, 架构整理第 6 步): see pruneDshLogs. */
  pruneLogs(now = Date.now()): number {
    return pruneDshLogs(join(this.options.dir, "logs"), now);
  }

  /**
   * Turns that ended without their tokens and speed (2026-10-27: until then Studio read only the first frame of DSH's
   * logs, so every DSH turn had none): read once from each session's log, matched to its turns by start time. One
   * session at a time, `gapMs` apart, so a Host just started is not held up. No model is called.
   */
  async backfillStats(gapMs = 200): Promise<number> {
    const home = join(this.options.dir, "home");
    let filled = 0;
    for (const s of this.store.listSessions()) {
      if (s.runtime !== "dsh" || !s.runtimeRef) continue;
      const missing = this.store.findItems(s.id, "turn").filter((t) => t.type === "turn" && t.state !== "running" && !t.decode);
      if (!missing.length) continue;
      await new Promise((r) => setTimeout(r, gapMs));
      try {
        const text = dshLogText(home, s.runtimeRef);
        if (text === null) continue;
        const stats = allTurnStats(text);
        const transcript = new DshTranscript(this.makeCore(), s.id);
        for (const t of missing) {
          if (t.type !== "turn") continue;
          const at = Date.parse(t.startedAt);
          const best = stats.reduce<DshTurnStats | null>((b, x) => (Math.abs(x.startedAt - at) < Math.abs((b?.startedAt ?? Infinity) - at) ? x : b), null);
          if (!best || Math.abs(best.startedAt - at) > BACKFILL_SLACK_MS || !best.decode) continue;
          transcript.applyStats(t.id, best);
          filled++;
        }
      } catch (err) {
        this.emit("log", `dsh stats backfill failed for ${s.id}: ${String(err)}`);
      }
    }
    return filled;
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
    if (!live.waiting.size && (live.inflight || live.auto) && this.store.getSession(sessionId)?.status === "awaiting-approval") this.setStatus(sessionId, "running");
  }

  // ---- helpers ----------------------------------------------------------------------------------------------------

  /** The session's other MCP servers that are on, and a key to tell a change. */
  private extraMcp(target: Id | { workspaceId: Id; mcp?: Record<string, boolean> }): { specs: Array<[string, McpServerSpec]>; key: string } {
    try {
      const plan = this.options.mcpServers?.launch(target, false);
      if (!plan) return { specs: [], key: "" };
      const names = Object.keys(plan.explicit).sort();
      return { specs: names.map((n) => [n, plan.explicit[n]!]), key: JSON.stringify(names.map((n) => [n, plan.explicit[n]])) };
    } catch (err) {
      this.emit("log", `MCP servers for a DSH session could not be read: ${String(err)}`);
      return { specs: [], key: "" };
    }
  }

  /** Which servers that are on could not go with the session: said when its process starts, not again while it is the same. */
  private tellSkippedMcp(sessionId: Id, skipped: ReadonlyArray<McpSkipped>): void {
    const message = skipped.length ? mcpSkippedNotice(skipped, "DeepSeek") : "";
    if (this.mcpTold.get(sessionId) === message) return;
    this.mcpTold.set(sessionId, message);
    if (message) this.appendItem(sessionId, { type: "notice", level: "warning", message }, { method: "dsh/mcp" });
  }

  private mcpChanged(sessionId: Id, live: Live): boolean {
    return !!this.options.mcpServers && this.extraMcp(sessionId).key !== live.mcpKey;
  }

  /** MCP 设置: a change reaches the process when it next starts — now if it is idle, else once the turn ends. */
  async refreshMcp(sessionId: Id): Promise<McpApply> {
    const live = this.live.get(sessionId);
    if (!live) return "next-message";
    if (!this.mcpChanged(sessionId, live)) return "now";
    if (live.inflight || live.auto) return "after-turn";
    await this.release(sessionId);
    return "next-message";
  }

  private mcpServers(token: string | undefined): unknown[] {
    const mcp = this.options.mcp?.();
    if (!mcp || !token) return [];
    return [{ type: "http", name: "amo", url: mcp.url, headers: [{ name: "Authorization", value: `Bearer ${mcp.token}` }, { name: MCP_SESSION_HEADER, value: token }] }];
  }

  /** Keeps what DSH offers, for the pickers; not from a channel with its own catalog (that is not DSH's own list). */
  private remember(config: ConfigOption[] | undefined, profile: ModelProfile | null): void {
    if (config?.length && !(profile && this.ownModels(profile))) this.store.setKv(this.optionsKey(profile), JSON.stringify(config));
  }

  /** Where the options DSH offers are kept: on the desktop app's account they are other models than with a key. */
  private optionsKey(profile: ModelProfile | null): string {
    return this.usesAccount(profile) ? DSH_ACCOUNT_OPTIONS_KEY : DSH_OPTIONS_KEY;
  }

  /** DSH's models on the profile's sign-in: the account's route on the account, the others with a key. */
  private modelsOf(profile: ModelProfile | null, config: readonly ConfigOption[]): ModelOption[] {
    return dshModels(config).filter((m) => this.routeAllowed(profile, m.id));
  }

  /** The site's own model names of a channel profile, or null (DSH's built-in catalog). */
  private ownModels(profile: ModelProfile): string[] | null {
    const models = profile.provider ? this.options.providers?.[profile.provider]?.models : undefined;
    return models?.length ? models : null;
  }

  /** Which of a channel's own names take pictures: its 能看图 (2026-11-11), else DSH_IMAGE_MODELS among them. */
  private ownImages(profile: ModelProfile): ReadonlySet<string> {
    const def = profile.provider ? this.options.providers?.[profile.provider] : undefined;
    const models = def?.models ?? [];
    return new Set(def?.imageModels ? def.imageModels.filter((m) => models.includes(m)) : models.filter((m) => DSH_IMAGE_MODELS.has(m)));
  }

  /**
   * A channel's catalog as a DSH patch file (written fresh for each process), or null when it has none. The ACP agent
   * starts on the session's `model` when the channel lists it, else on the channel's default: DSH tells at initialize
   * whether that one takes images (2026-11-11: it always started on the default, so a session switched to a model that
   * takes images was still refused them). One file per starting model: two sessions may start at once.
   */
  private catalogPatch(profile: ModelProfile, model?: string): string | null {
    const models = this.ownModels(profile);
    if (!models) return null;
    const asked = model?.replace(/^deepseek-official\//, "");
    const own = profile.model?.replace(/^deepseek-official\//, "");
    const first = asked && models.includes(asked) ? asked : own && models.includes(own) ? own : models[0]!;
    const dir = join(this.options.dir, "patches");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${profile.provider}-${first.replace(/[^A-Za-z0-9._-]+/g, "_")}.yml`);
    writeFileSync(file, catalogPatchYaml(profile.label, models, first, this.ownImages(profile)));
    return file;
  }

  /** The key of `profile` (null: 「检查」, which checks the first DSH profile, the built-in one). */
  private credentialOf(profile: ModelProfile | null): string | undefined {
    return profile?.credentialId ?? this.options.profiles.find((p) => p.runtime === "dsh" && p.credentialId)?.credentialId;
  }

  /**
   * Whether `profile` signs in with the DSH desktop app's account (设置 → 模型 → DeepSeek, 2026-11-03): only the
   * built-in DeepSeek (null: 「检查」, which checks it); a third-party channel always uses its own key.
   */
  private usesAccount(profile: ModelProfile | null): boolean {
    if (profile?.custom) return false;
    const credentialId = this.credentialOf(profile);
    let keySaved = false;
    try {
      keySaved = !!(credentialId && this.options.credentials.read(credentialId));
    } catch {
      keySaved = false;
    }
    return readDshAuth(this.store, keySaved) === "account";
  }

  /** Whether a model id belongs to the profile's sign-in: the account's route on the account, any other with a key. */
  private routeAllowed(profile: ModelProfile | null, id: string): boolean {
    return id.startsWith(`${DSH_ACCOUNT_PROVIDER}/`) === this.usesAccount(profile);
  }

  /** The desktop app's credentials and the ACP agent on the account's `model` (its default when none), as a DSH patch file. */
  private accountPatch(file: string, model: string | undefined): string {
    const name = model ? model.slice(DSH_ACCOUNT_PROVIDER.length + 1) : DSH_ACCOUNT_DEFAULT_MODEL;
    const dir = join(this.options.dir, "patches");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `account-${name.replace(/[^A-Za-z0-9._-]+/g, "_")}.yml`);
    writeFileSync(path, accountPatchYaml(file, name));
    return path;
  }

  /** The session's model as the ACP agent's default (DSH then says whether it takes images), as a DSH patch file. */
  private modelPatch(model: string): string | null {
    const cut = model.indexOf("/");
    if (cut <= 0) return null;
    const dir = join(this.options.dir, "patches");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `model-${model.replace(/[^A-Za-z0-9._-]+/g, "_")}.yml`);
    writeFileSync(file, modelPatchYaml(model.slice(0, cut), model.slice(cut + 1)));
    return file;
  }

  /** Only the retry policy (every patch above carries it too), as a DSH patch file. */
  private retryPatch(): string {
    const dir = join(this.options.dir, "patches");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "retry.yml");
    writeFileSync(file, retryPatchYaml());
    return file;
  }

  private cachedOptions(profile: ModelProfile | null): ConfigOption[] | null {
    try {
      const v = JSON.parse(this.store.getKv(this.optionsKey(profile))?.value ?? "null") as unknown;
      return Array.isArray(v) ? (v as ConfigOption[]) : null;
    } catch {
      return null;
    }
  }

  /** A readable error: DSH's own message, or what went wrong talking to it. */
  private explain(err: unknown): Error {
    if (err instanceof Error && (err as { code?: unknown }).code === "bad_request") return err;
    // DSH's details go with its message (2026-11-09, ybf's report: only「Internal error」showed, and what failed —
    // `mcp-client(figma): …` in data.details — was nowhere, not in the logs either).
    const details = err instanceof AcpError ? acpDetails(err).slice(0, 300) : "";
    const message = (err instanceof Error ? err.message : String(err)) + (details && !(err as Error).message?.includes(details) ? `（${details}）` : "");
    return Object.assign(new Error(message.startsWith("DSH") ? message : `DSH：${message}`), { code: "runtime_error" });
  }

  private profile(id: Id): ModelProfile {
    const p = this.options.profiles.find((x) => x.id === id);
    if (!p || p.runtime !== "dsh") throw new Error(`profile ${id} is not a DSH profile`);
    return p;
  }

}

/** Images as ACP inline blocks, read now (a missing file fails the send before anything is shown or queued). */
function imageBlocks(images: readonly Attachment[]): ImageBlock[] {
  return images.map((a) => ({ type: "image", mimeType: a.mime, data: readFileSync(a.path).toString("base64") }));
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

/** Messages queued during a turn, as one: their texts one after another, all their images, and their rows. */
function takeQueue(live: Live): { text: string; images: ImageBlock[]; items: Id[] } | null {
  const queued = live.queue.splice(0);
  if (!queued.length) return null;
  return { text: queued.map((q) => q.text).filter(Boolean).join("\n\n"), images: queued.flatMap((q) => q.images), items: queued.map((q) => q.itemId) };
}

/** The DSH patch that starts its ACP agent on `provider`/`model` (names JSON-quoted, which YAML reads as strings). */
export function modelPatchYaml(provider: string, model: string): string {
  return [
    "# Written by AMO Studio: the session's model as the ACP agent's default, so DSH says whether it takes images.",
    `- id: ${DSH_KEY_PLUGIN}`,
    "  config:",
    ...retryPolicyYaml(),
    "- id: acp",
    "  config:",
    `    provider: ${JSON.stringify(provider)}`,
    `    model: ${JSON.stringify(model)}`,
    "",
  ].join("\n");
}

/**
 * The DSH patch that makes a channel's model names DSH's catalog on its DeepSeek route (`llm-deepseek` has no config
 * of its own to lose) and `first` the ACP agent's default. Names are JSON-quoted, which YAML reads as strings. The
 * names in `images` (the channel's 能看图; by default the ones DSH's own catalog says take them) say so: in DSH an entry
 * without `inputModalities` is text only.
 */
export function catalogPatchYaml(label: string, models: readonly string[], first: string, images: ReadonlySet<string> = DSH_IMAGE_MODELS): string {
  return [
    `# Written by AMO Studio for the channel ${JSON.stringify(label)}: the site's own model names. Rewritten on every start.`,
    `- id: ${DSH_KEY_PLUGIN}`,
    "  config:",
    "    models:",
    ...models.flatMap((m) => [`      - id: ${JSON.stringify(m)}`, ...(images.has(m) ? ['        inputModalities: ["text", "image"]'] : [])]),
    ...retryPolicyYaml(),
    "- id: acp",
    "  config:",
    "    provider: deepseek-official",
    `    model: ${JSON.stringify(first)}`,
    "",
  ].join("\n");
}

/**
 * Why a picture was refused and what the person can do about it, where they do it. `models`: what the session's
 * picker offers; `switched`: the session changed models during the turn going on (its process starts again after it).
 * `takes`: whether a model id takes pictures (a channel's 能看图, else DSH's own catalog).
 * 2026-11-11: the old「换成能看图的型号，例如 DeepSeek-V4.1-Flash」named a model the person's channel did not list, and
 * not where to change it.
 */
export function noImagesMessage(profile: ModelProfile, models: readonly ModelOption[], model: string | undefined, switched: boolean, takes: (id: string) => boolean = (id) => DSH_IMAGE_MODELS.has(id.slice(id.indexOf("/") + 1))): string {
  const shown = (m: ModelOption) => (m.label === "deepseek-flash" ? `deepseek-flash（${DSH_IMAGE_MODEL_LABEL}）` : m.label);
  const current = model ? models.find((m) => m.id === model) : models.find((m) => m.isDefault);
  const name = current ? shown(current) : (model?.slice(model.indexOf("/") + 1) ?? "这个型号");
  const picker = "点输入框下面的型号（Alt M）";
  if (switched) return `型号刚换过：这一轮做完才用上「${name}」，现在这个不收图片；等这一轮做完再发图片`;
  // One DSH's catalog says it takes images, yet this DSH said no: nothing to pick, the DSH itself is the place to look.
  if (current && takes(current.id)) return `DSH 说「${name}」不收图片，图片没有发出去；到 设置 → 模型 → DeepSeek 点「检查」，看 DSH 是不是要更新`;
  const other = models.find((m) => takes(m.id));
  if (other) return `「${name}」不收图片；${picker}换成「${shown(other)}」再发（上下文不变）`;
  if (profile.custom)
    return `「${profile.label}」的型号都没标「能看图」：到 设置 → 模型 →「${profile.label}」→ 编辑，在「能看图」那一行点亮能看图的型号（DeepSeek 能看图的是 ${DSH_IMAGE_MODEL_LABEL}，官方叫 deepseek-flash；列表里没有就加一行，可以点「从网址读取」看这个网址叫它什么），保存后${picker}换过去再发`;
  return `「${name}」不收图片（DSH 说这个型号不支持图片输入）；${picker}换成 ${DSH_IMAGE_MODEL_LABEL} 再发`;
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

/** The servers DSH can take in ACP's shape, and the ones it cannot (it refuses the whole session for one, 2026-11-09). */
export function fitMcp(specs: ReadonlyArray<[string, McpServerSpec]>, transports: McpTransports): { list: Array<Record<string, unknown>>; skipped: McpSkipped[] } {
  const list: Array<Record<string, unknown>> = [];
  const skipped: McpSkipped[] = [];
  for (const [name, spec] of specs) {
    if (mcpFits(spec, transports)) list.push(acpServer(name, spec));
    else skipped.push({ name, type: spec.type });
  }
  return { list, skipped };
}

/**
 * The MCP server DSH names when it could not connect to one: it fails the whole session/new (or resume) with
 * `{code: -32603, message: "Internal error", data: {details: "mcp-client(figma): initial connection or tool synchronization
 * failed"}}` (DSH 0.2.1-rc.5, 2026-11-09, ybf's report). Only a name the session was given counts.
 */
export function failingMcpOf(err: unknown, names: readonly string[]): { name: string; why: string } | null {
  if (!(err instanceof AcpError)) return null;
  const details = acpDetails(err);
  const hit = /mcp-client\(([^)]+)\):?\s*(.*)/.exec(details);
  if (!hit || !names.includes(hit[1]!)) return null;
  return { name: hit[1]!, why: hit[2]!.trim().slice(0, 200) };
}

/** `data.details` of a DSH error, the part that says what failed ("" when there is none). */
function acpDetails(err: AcpError): string {
  const data = err.data as { details?: unknown } | undefined;
  return data && typeof data.details === "string" ? data.details : "";
}

/**
 * Opens a DSH session with the servers that fit, leaving out each one DSH says it could not connect to and trying again
 * (2026-11-09, the user: 不应当要人去关掉 project 里指定的 MCP，应该在会话里处理 — one server it cannot reach is no
 * reason to have no session). What was left out goes into `skipped`, for the session to say.
 */
export async function withoutFailingMcp<T>(fit: { list: ReadonlyArray<Record<string, unknown>> }, skipped: McpSkipped[], open: (list: ReadonlyArray<Record<string, unknown>>) => Promise<T>): Promise<T> {
  let list = [...fit.list];
  for (;;) {
    try {
      return await open(list);
    } catch (err) {
      const bad = failingMcpOf(err, list.map((s) => String(s.name)));
      if (!bad) throw err;
      const server = list.find((s) => s.name === bad.name)!;
      list = list.filter((s) => s !== server);
      skipped.push({ name: bad.name, type: typeof server.type === "string" ? server.type : "stdio", failed: bad.why });
    }
  }
}
