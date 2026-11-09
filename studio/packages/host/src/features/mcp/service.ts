import {
  AMO_MCP_SERVER_NAME,
  isCommon,
  MCP_LIMITS,
  MCP_OFF_BY_DEFAULT,
  MCP_SECRET_MASK,
  mcpSummary,
  type Id,
  type McpApply,
  type McpChoices,
  type McpEntry,
  type McpProjectState,
  type McpServerSpec,
  type McpServerStatusSeen,
  type McpSessionState,
  type McpSource,
  type McpState,
  type NewStudioMcpServer,
  type Session,
  type StudioMcpServer,
  type StudioMcpServerPatch,
  type Workspace,
} from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import type { CredentialStore } from "../../runtime/credentials.js";
import type { McpDraft, McpLaunch } from "../../runtime/mcp-launch.js";

export type { McpLaunch };
import { expandVars, parseSpec, personClaudeConfig, projectServers, userServers, type LocalMcpServer } from "./local.js";

// MCP 设置 (2026-11-04, plans/done/mcp.md). Studio's own servers, the person's Claude Code ones, and which are on at the
// global level, for a project and for a session; what each runtime gets when it starts a session's process.

const SERVERS_KEY = "mcp:servers";
const GLOBAL_KEY = "mcp:global";
const STATUS_KEY = "mcp:status";
const projectKey = (id: Id) => `mcp:project:${id}`;
const secretId = (id: Id) => `mcp-${id}`;
/** How long after a change the running sessions get it (see changed()). */
const REFRESH_DELAY_MS = 300;

/** Studio's server as kept: its secrets (env and header values) are in the credential store, unless it has none. */
interface StoredServer extends Omit<StudioMcpServer, "spec"> {
  spec: McpServerSpec;
  /** Where the secrets went when the credential store could not take them (not Windows): kept here. */
  secrets?: { env?: Record<string, string>; headers?: Record<string, string> };
}

interface GlobalChoices {
  loadLocal?: boolean;
  on?: Record<string, boolean>;
}

/** One server Studio could hand a session, before any level's choice. */
interface Candidate {
  name: string;
  source: McpSource;
  spec?: McpServerSpec;
  serverId?: Id;
  defaultOn: boolean;
  note?: string;
}

/** Sources Claude Code loads by itself from the person's config (so a name seen with one of these is no `seen`). */
const CONFIG_SCOPES = new Set(["user", "project", "local", "sdk", "dynamic"]);

export class McpFeature extends Feature {
  // ---- 设置 → MCP ------------------------------------------------------------------------------------------------

  state(): McpState {
    return { loadLocal: this.loadLocal(), servers: this.stored().map((s) => this.shown(s)), entries: this.resolve(this.candidates(null), [this.global().on ?? {}]), claudeConfig: this.claudeConfig() };
  }

  setGlobal(input: unknown): McpState {
    const body = input && typeof input === "object" ? (input as { loadLocal?: unknown; choices?: unknown }) : {};
    const g = this.global();
    if (body.loadLocal !== undefined) {
      if (typeof body.loadLocal !== "boolean") throw new HostError("bad_request", "loadLocal must be true or false");
      g.loadLocal = body.loadLocal;
    }
    if (body.choices !== undefined) g.on = merge(g.on ?? {}, choices(body.choices));
    this.store.setKv(GLOBAL_KEY, JSON.stringify(g));
    this.changed({});
    return this.state();
  }

  create(input: unknown, by: StudioMcpServer["by"] = "person"): StudioMcpServer {
    const all = this.stored();
    if (all.length >= MCP_LIMITS.servers) throw new HostError("conflict", `最多存 ${MCP_LIMITS.servers} 个 MCP，先删掉不用的`);
    const body = (input && typeof input === "object" ? input : {}) as Partial<NewStudioMcpServer>;
    const name = this.name(body.name, all);
    const at = new Date().toISOString();
    const server: StoredServer = { id: newId("mcp"), name, spec: { type: "stdio" }, on: body.on ?? true, note: note(body.note), by, createdAt: at, updatedAt: at };
    this.putSpec(server, spec(body.spec), null);
    this.save([...all, server]);
    return this.shown(server);
  }

  update(id: Id, patch: unknown, by: StudioMcpServer["by"] = "person"): StudioMcpServer {
    const all = this.stored();
    const current = all.find((s) => s.id === id);
    if (!current) throw new HostError("not_found", `没有这个 MCP：${id}`);
    const p = (patch && typeof patch === "object" ? patch : {}) as StudioMcpServerPatch;
    const next: StoredServer = { ...current, by, updatedAt: new Date().toISOString() };
    if (p.name !== undefined) next.name = this.name(p.name, all.filter((s) => s.id !== id));
    if (p.on !== undefined) {
      if (typeof p.on !== "boolean") throw new HostError("bad_request", "on must be true or false");
      next.on = p.on;
    }
    if (p.note !== undefined) next.note = note(p.note);
    if (p.spec !== undefined) this.putSpec(next, spec(p.spec), this.secretsOf(current));
    this.save(all.map((s) => (s.id === id ? next : s)));
    return this.shown(next);
  }

  remove(id: Id): void {
    const all = this.stored();
    if (!all.some((s) => s.id === id)) throw new HostError("not_found", `没有这个 MCP：${id}`);
    const store = this.secretStore();
    try {
      store?.remove(secretId(id));
    } catch {
      // The entry may never have been written (a server without secrets).
    }
    this.save(all.filter((s) => s.id !== id));
  }

  // ---- 编辑项目 ---------------------------------------------------------------------------------------------------

  project(workspaceId: Id): McpProjectState {
    const ws = this.projectWorkspace(workspaceId);
    return { workspaceId, loadLocal: this.loadLocal(), entries: this.resolve(this.candidates(ws), [this.global().on ?? {}, this.projectChoices(ws.id)]) };
  }

  setProject(workspaceId: Id, input: unknown): McpProjectState {
    const ws = this.projectWorkspace(workspaceId);
    const body = input && typeof input === "object" ? (input as { choices?: unknown }) : {};
    this.store.setKv(projectKey(ws.id), JSON.stringify(merge(this.projectChoices(ws.id), choices(body.choices))));
    this.changed({ workspaceId: ws.id });
    return this.project(ws.id);
  }

  // ---- a session ---------------------------------------------------------------------------------------------------

  async session(sessionId: Id): Promise<McpSessionState> {
    const s = this.requireSession(sessionId);
    const ws = this.store.getWorkspace(s.workspaceId);
    const live = s.runtime === "claude" ? await this.runtime.mcpStatus?.(sessionId).catch(() => null) : null;
    const codex = s.runtime === "codex";
    const levels = codex ? [this.global().on ?? {}] : [this.global().on ?? {}, ws ? this.projectChoices(ws.id) : {}, s.options.mcp ?? {}];
    const candidates = codex ? this.candidates(null).filter((c) => c.source === "studio") : this.candidates(ws ?? null);
    const entries = this.resolve(candidates, levels).map((e) => {
      const now = live?.find((x) => x.name === e.name);
      return now ? { ...e, status: { status: now.status, ...(now.error ? { error: now.error } : {}), ...(now.source ? { source: now.source } : {}), at: new Date().toISOString() } } : e;
    });
    // Servers the running process has that no list here knows (a plugin's, a connector) are shown too.
    for (const x of live ?? []) {
      if (x.name === AMO_MCP_SERVER_NAME || entries.some((e) => e.name === x.name)) continue;
      entries.push({ name: x.name, source: "seen", summary: "", on: x.status !== "disabled", inherited: true, status: { status: x.status, ...(x.source ? { source: x.source } : {}), at: new Date().toISOString() } });
    }
    return { sessionId, runtime: s.runtime, loadLocal: this.loadLocal(), entries, perSession: !codex, live: !!live };
  }

  async setSession(sessionId: Id, input: unknown): Promise<McpSessionState & { apply: McpApply }> {
    const s = this.requireSession(sessionId);
    if (s.archivedAt) throw new HostError("read_only", "已归档的会话不能改 MCP");
    if (s.runtime === "codex") throw new HostError("bad_request", "Codex 的 MCP 在它的 app-server 启动时就定了，不能按会话改；到 设置 → MCP 里改全局的");
    const body = input && typeof input === "object" ? (input as { choices?: unknown }) : {};
    const mcp = merge(s.options.mcp ?? {}, choices(body.choices));
    const options = { ...s.options };
    if (Object.keys(mcp).length) options.mcp = mcp;
    else delete options.mcp;
    await this.wrap(() => this.runtime.setOptions(sessionId, options));
    const apply = (await this.runtime.refreshMcp?.(sessionId)) ?? "next-message";
    return { ...(await this.session(sessionId)), apply };
  }

  /**
   * Turns one server on for a session (an agent's mcp_server_save with enableHere). The tool call that asks is still
   * running: its process gets the change a moment after it has returned (changed() waits the same way).
   */
  async enableFor(sessionId: Id, name: string): Promise<McpApply> {
    const s = this.requireSession(sessionId);
    if (s.runtime === "codex") return "codex-restart";
    await this.wrap(() => this.runtime.setOptions(sessionId, { ...s.options, mcp: { ...(s.options.mcp ?? {}), [name]: true } }));
    setTimeout(() => void this.runtime.refreshMcp?.(sessionId).catch(() => undefined), REFRESH_DELAY_MS).unref?.();
    return s.runtime === "claude" ? "now" : "after-turn";
  }

  /** The choices a new session of a task starts with: its latest main session's. */
  inherited(taskId: Id | null): Record<string, boolean> | undefined {
    if (!taskId) return undefined;
    const latest = this.store
      .listSessions()
      .filter((x) => x.taskId === taskId && x.kind === "main" && !x.archivedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return latest?.options.mcp && Object.keys(latest.options.mcp).length ? { ...latest.options.mcp } : undefined;
  }

  /**
   * A new session's MCP choices when the agent that opens it names some (session_start's mcp, 2026-11-09, the user: 让 AI
   * 拉起的时候设置需要使用的 MCP — a sub-session went on with the task's 「playwright 关」 and had no browser): those over
   * the task's latest choices. A name the session's project does not offer is refused, with the ones it does.
   */
  chooseFor(workspaceId: Id, taskId: Id | null, runtime: string, asked: unknown): Record<string, boolean> | undefined {
    if (asked === undefined || asked === null) return undefined;
    if (typeof asked !== "object" || Array.isArray(asked) || Object.values(asked).some((v) => typeof v !== "boolean")) throw new HostError("bad_request", "mcp 要写成 {\"名字\": true 或 false}，例如 {\"playwright\": true}");
    const want = asked as Record<string, boolean>;
    if (!Object.keys(want).length) return undefined;
    if (runtime === "codex") throw new HostError("bad_request", "Codex 的 MCP 在它的 app-server 启动时就定了，不能按会话设：去掉 mcp，或换一个模型");
    const ws = this.store.getWorkspace(workspaceId) ?? null;
    const known = this.candidates(ws).map((c) => c.name);
    const unknown = Object.keys(want).filter((n) => !known.includes(n));
    if (unknown.includes(AMO_MCP_SERVER_NAME)) throw new HostError("bad_request", `${AMO_MCP_SERVER_NAME} 每个会话都带着，不用写进 mcp`);
    if (unknown.length) throw new HostError("bad_request", `没有这个 MCP：${unknown.join("、")}。这个项目能用的：${known.join("、") || "（没有）"}`);
    return { ...(this.inherited(taskId) ?? {}), ...want };
  }

  // ---- for the runtimes ---------------------------------------------------------------------------------------------

  /**
   * What a session's process gets. `native`: Claude in the person's own config dir, where the CLI reads their servers
   * itself (OAuth, plugins and its own approvals as in a terminal); otherwise Studio passes the ones that are on.
   */
  launch(target: Id | McpDraft, native: boolean): McpLaunch {
    const s = typeof target === "string" ? this.store.getSession(target) : null;
    const empty: McpLaunch = { explicit: {}, deny: [], enableJson: [], strict: true };
    if (typeof target === "string" && !s) return empty;
    const workspaceId = s ? s.workspaceId : (target as McpDraft).workspaceId;
    const own = (s ? s.options.mcp : (target as McpDraft).mcp) ?? {};
    const ws = this.store.getWorkspace(workspaceId) ?? null;
    const loadLocal = this.loadLocal();
    const candidates = this.candidates(ws);
    const entries = this.resolve(candidates, [this.global().on ?? {}, ws ? this.projectChoices(ws.id) : {}, own]);
    const byName = new Map(candidates.map((c) => [c.name, c]));
    const out: McpLaunch = { ...empty, explicit: {}, strict: !native || !loadLocal };
    for (const e of entries) {
      const c = byName.get(e.name);
      if (!c) continue;
      if (c.source === "studio") {
        if (e.on && c.serverId) out.explicit[e.name] = this.withSecrets(c.serverId);
        continue;
      }
      if (!loadLocal) continue;
      if (native) {
        if (!e.on) out.deny.push(e.name);
        else if (c.source === "project") out.enableJson.push(e.name);
      } else if (e.on && c.spec) out.explicit[e.name] = expandVars(c.spec);
    }
    return out;
  }

  /** Codex: Studio's servers that are on at the global level (its app-server is shared by every session on it). */
  codexServers(): Record<string, McpServerSpec> {
    const on = this.global().on ?? {};
    const out: Record<string, McpServerSpec> = {};
    for (const s of this.stored()) if (on[s.name] ?? s.on) out[s.name] = this.withSecrets(s.id);
    return out;
  }

  /** Statuses a Claude session reported (its init message): kept as each server's last known state. */
  noteStatus(sessionId: Id, list: ReadonlyArray<{ name: string; status: string; source?: string; error?: string }>): void {
    const seen = this.statuses();
    const at = new Date().toISOString();
    let changed = false;
    for (const x of list) {
      if (!x.name || x.name === AMO_MCP_SERVER_NAME) continue;
      const before = seen[x.name];
      const next: McpServerStatusSeen = { status: x.status, ...(x.error ? { error: x.error } : {}), ...(x.source ? { source: x.source } : {}), at };
      if (before && before.status === next.status && before.source === next.source && before.error === next.error && Date.parse(at) - Date.parse(before.at) < 3_600_000) continue;
      seen[x.name] = next;
      changed = true;
    }
    if (!changed) return;
    this.store.setKv(STATUS_KEY, JSON.stringify(seen));
    this.publish({ type: "mcp.changed", sessionId });
  }

  // ---- inside --------------------------------------------------------------------------------------------------------

  private loadLocal(): boolean {
    return this.global().loadLocal ?? true;
  }

  /** The person's ~/.claude.json (host-process passes it; without one, as in unit tests of other features, none). */
  private claudeConfig(): string {
    return this.options.claudeConfigFile ?? (this.options.localClaudeHome ? personClaudeConfig(this.options.localClaudeHome, true) : "");
  }

  private claudeDir(): string {
    return this.options.localClaudeHome ?? "";
  }

  /** Every server a session in `ws` (null: the global level) could get, each name once. */
  private candidates(ws: Workspace | null): Candidate[] {
    const out: Candidate[] = [];
    const taken = new Set<string>();
    const add = (c: Candidate) => {
      if (taken.has(c.name) || c.name === AMO_MCP_SERVER_NAME) return;
      taken.add(c.name);
      out.push(c);
    };
    for (const s of this.stored()) add({ name: s.name, source: "studio", spec: s.spec, serverId: s.id, defaultOn: s.on, ...(s.note ? { note: s.note } : {}) });
    if (!this.loadLocal()) return out;
    const person = (s: LocalMcpServer): Candidate => {
      const off = MCP_OFF_BY_DEFAULT[s.name];
      if (s.source === "project") {
        const note = s.approved === false ? "在 Claude Code 里被拒绝过，默认不启用" : s.approved === null ? "Claude Code 还没批准过，默认不启用；在这里打开就会启用" : undefined;
        return { name: s.name, source: s.source, spec: s.spec, defaultOn: s.approved === true && !off, ...(off ? { note: off } : note ? { note } : {}) };
      }
      return { name: s.name, source: s.source, spec: s.spec, defaultOn: !off, ...(off ? { note: off } : {}) };
    };
    // Claude Code's own order when names repeat: local over project over user.
    if (ws && !isCommon(ws)) for (const s of projectServers(this.claudeConfig(), this.claudeDir(), ws.path).sort((a, b) => (a.source === b.source ? 0 : a.source === "local" ? -1 : 1))) add(person(s));
    for (const s of userServers(this.claudeConfig())) add(person(s));
    for (const [name, st] of Object.entries(this.statuses())) {
      if (st.source && CONFIG_SCOPES.has(st.source)) continue;
      const off = MCP_OFF_BY_DEFAULT[name];
      add({ name, source: "seen", defaultOn: !off, note: off ?? `Claude 会话里见过（${st.source ?? "来源不明"}），只有 Claude 的会话会加载` });
    }
    return out;
  }

  /** Each candidate through the levels (outermost first): `on` is the last level's, `inherited` the one before it. */
  private resolve(candidates: Candidate[], levels: ReadonlyArray<Record<string, boolean>>): McpEntry[] {
    const statuses = this.statuses();
    return candidates.map((c) => {
      let on = c.defaultOn;
      let inherited = on;
      levels.forEach((level, i) => {
        if (i === levels.length - 1) inherited = on;
        if (level[c.name] !== undefined) on = level[c.name]!;
      });
      const own = levels[levels.length - 1]?.[c.name];
      const status = statuses[c.name];
      return {
        name: c.name,
        source: c.source,
        summary: c.spec ? mcpSummary(c.spec) : "",
        ...(c.spec ? { type: c.spec.type } : {}),
        ...(c.serverId ? { serverId: c.serverId } : {}),
        on,
        inherited,
        ...(own !== undefined ? { choice: own } : {}),
        ...(c.note ? { note: c.note } : {}),
        ...(status ? { status } : {}),
      };
    });
  }

  private global(): GlobalChoices {
    return readJson<GlobalChoices>(this.store.getKv(GLOBAL_KEY)?.value) ?? {};
  }

  private projectChoices(id: Id): Record<string, boolean> {
    return readJson<Record<string, boolean>>(this.store.getKv(projectKey(id))?.value) ?? {};
  }

  private statuses(): Record<string, McpServerStatusSeen> {
    return readJson<Record<string, McpServerStatusSeen>>(this.store.getKv(STATUS_KEY)?.value) ?? {};
  }

  private stored(): StoredServer[] {
    const list = readJson<StoredServer[]>(this.store.getKv(SERVERS_KEY)?.value);
    return Array.isArray(list) ? list : [];
  }

  private save(list: StoredServer[]): void {
    this.store.setKv(SERVERS_KEY, JSON.stringify(list));
    this.changed({});
  }

  /** Tells the UI, and the runtimes, which apply what changed to the sessions they have running. */
  private changed(scope: { workspaceId?: Id }): void {
    this.publish({ type: "mcp.changed", ...scope });
    const refresh = this.runtime.refreshMcp?.bind(this.runtime);
    if (!refresh) return;
    const ids = this.store
      .listSessions()
      .filter((s) => !s.archivedAt && s.kind !== "sub" && (s.runtime === "claude" || s.runtime === "dsh") && (!scope.workspaceId || s.workspaceId === scope.workspaceId))
      .map((s) => s.id);
    // Not at once: the change may come from an agent's tool call (mcp_server_save), whose own MCP set must not change
    // under the call.
    setTimeout(() => {
      for (const id of ids) void refresh(id).catch((err: unknown) => this.publish({ type: "host.error", message: `MCP 没能应用到会话 ${id}：${String(err)}` }));
    }, REFRESH_DELAY_MS).unref?.();
  }

  private projectWorkspace(id: Id): Workspace {
    const ws = this.requireWorkspace(id);
    if (isCommon(ws)) throw new HostError("bad_request", "公共空间没有项目级的 MCP 设置");
    return ws;
  }


  private name(value: unknown, others: readonly StoredServer[]): string {
    if (typeof value !== "string" || !value.trim()) throw new HostError("bad_request", "MCP 要有名字");
    const name = value.trim();
    if (name.length > MCP_LIMITS.name || !/^[A-Za-z0-9_-]+$/.test(name)) throw new HostError("bad_request", `名字只能用英文字母、数字、_ 和 -，最长 ${MCP_LIMITS.name} 个字符`);
    if (name === AMO_MCP_SERVER_NAME) throw new HostError("bad_request", "amo 是 Studio 自己的 MCP，换个名字");
    if (others.some((s) => s.name === name)) throw new HostError("conflict", `已经有叫 ${name} 的 MCP 了`);
    return name;
  }

  private secretStore(): CredentialStore | null {
    const c = this.options.credentials;
    return c && "write" in c ? c : null;
  }

  /** The stored secrets of a server. */
  private secretsOf(s: StoredServer): { env?: Record<string, string>; headers?: Record<string, string> } {
    if (s.secrets) return s.secrets;
    const raw = this.options.credentials?.read(secretId(s.id));
    return readJson<{ env?: Record<string, string>; headers?: Record<string, string> }>(raw ?? undefined) ?? {};
  }

  /**
   * Keeps a spec: env and header values go to the credential store (the kv keeps their names with empty values);
   * MCP_SECRET_MASK keeps the value stored before.
   */
  private putSpec(server: StoredServer, next: McpServerSpec, before: { env?: Record<string, string>; headers?: Record<string, string> } | null): void {
    const keep = (m: Record<string, string> | undefined, old: Record<string, string> | undefined) => (m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v === MCP_SECRET_MASK ? (old?.[k] ?? "") : v])) : undefined);
    const env = keep(next.env, before?.env);
    const headers = keep(next.headers, before?.headers);
    const blank = (m?: Record<string, string>) => (m ? Object.fromEntries(Object.keys(m).map((k) => [k, ""])) : undefined);
    server.spec = { ...next, ...(env ? { env: blank(env)! } : {}), ...(headers ? { headers: blank(headers)! } : {}) };
    delete server.secrets;
    const secrets = { ...(env ? { env } : {}), ...(headers ? { headers } : {}) };
    const store = this.secretStore();
    const has = Object.keys(secrets).length > 0;
    try {
      if (has) store?.write(secretId(server.id), JSON.stringify(secrets));
      else store?.remove(secretId(server.id));
      if (has && !store) server.secrets = secrets;
    } catch {
      // No credential store here (not Windows): kept with the server in the data folder, as Claude Code keeps its own.
      if (has) server.secrets = secrets;
    }
  }

  /** The spec with its secrets, for a process. */
  private withSecrets(id: Id): McpServerSpec {
    const s = this.stored().find((x) => x.id === id);
    if (!s) return { type: "stdio" };
    const sec = this.secretsOf(s);
    const fill = (m: Record<string, string> | undefined, v: Record<string, string> | undefined) => (m ? Object.fromEntries(Object.keys(m).map((k) => [k, v?.[k] ?? ""])) : undefined);
    const env = fill(s.spec.env, sec.env);
    const headers = fill(s.spec.headers, sec.headers);
    return { ...s.spec, ...(env ? { env } : {}), ...(headers ? { headers } : {}) };
  }

  /** As the UI and agents see it: secrets masked (an empty one stays empty, so the person sees it is not filled in). */
  private shown(s: StoredServer): StudioMcpServer {
    const sec = this.secretsOf(s);
    const mask = (m: Record<string, string> | undefined, v: Record<string, string> | undefined) => (m ? Object.fromEntries(Object.keys(m).map((k) => [k, v?.[k] ? MCP_SECRET_MASK : ""])) : undefined);
    const env = mask(s.spec.env, sec.env);
    const headers = mask(s.spec.headers, sec.headers);
    const { secrets: _secrets, ...rest } = s;
    return { ...rest, spec: { ...s.spec, ...(env ? { env } : {}), ...(headers ? { headers } : {}) } };
  }
}

function readJson<T>(raw: string | undefined | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** A `{ name: true | false | null }` body. */
function choices(v: unknown): McpChoices {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HostError("bad_request", "choices must be an object of server names");
  const out: McpChoices = {};
  for (const [k, x] of Object.entries(v)) {
    if (x !== null && typeof x !== "boolean") throw new HostError("bad_request", `choices.${k} must be true, false or null`);
    out[k] = x as boolean | null;
  }
  return out;
}

/** Applies choices: null removes the name's own choice. */
function merge(base: Record<string, boolean>, patch: McpChoices): Record<string, boolean> {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

function note(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new HostError("bad_request", "note must be text");
  return v.trim().slice(0, 300);
}

/** A spec from the UI or an agent: an `mcpServers` entry (Claude Code's shape). */
function spec(v: unknown): McpServerSpec {
  const parsed = parseSpec(v);
  if (!parsed) throw new HostError("bad_request", "MCP 配置不对：本地程序要有 command，远程的要有 url（type 为 http 或 sse）");
  return parsed;
}
