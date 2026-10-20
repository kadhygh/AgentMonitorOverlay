import { EventEmitter } from "node:events";
import type { HostErrorCode, HostEvent, Id, ModelProfile, Session, StateSnapshot, Task, Topic, Workspace } from "@amo-studio/protocol";
import { isCommon } from "@amo-studio/protocol";
import { type HostEventInput, type Store } from "./store/store.js";
import type { SessionRuntimeApi } from "./runtime/runtime.js";
import type { CredentialReader, CredentialStore } from "./runtime/credentials.js";
import type { TerminalLauncher } from "./terminal/launcher.js";
import type { ChannelRegistry } from "./runtime/channels.js";
import type { DshRuntime } from "./runtime/dsh/dsh-runtime.js";
import { DshFeature } from "./features/dsh/service.js";
import { ProjectsFeature } from "./features/projects/service.js";
import { ConfigFeature } from "./features/config/service.js";
import { TasksFeature } from "./features/tasks/service.js";
import { TopicsFeature } from "./features/topics/service.js";
import { SessionsFeature } from "./features/sessions/service.js";
import { PlanningFeature } from "./features/planning/service.js";
import { CollabFeature } from "./features/collab/service.js";
import { CanvasFeature } from "./features/canvas/service.js";
import { ReviewFeature } from "./features/review/service.js";
import { PacksFeature } from "./features/packs/service.js";
import { AttachmentsFeature } from "./features/attachments/service.js";
import { ScratchpadFeature } from "./features/scratchpad/service.js";
import { GitReviewFeature } from "./features/gitreview/service.js";
import { FilesFeature } from "./features/files/service.js";
import { OpenInFeature } from "./features/openin/service.js";
import { MarksFeature } from "./features/marks/service.js";
import { TopicDocsFeature } from "./features/topicdocs/service.js";
import { TaskPlansFeature } from "./features/taskplans/service.js";
import { RelaysFeature } from "./features/relays/service.js";
import { ChatFilesFeature } from "./features/chatfiles/service.js";
import { CliFeature } from "./features/cli/service.js";
import { DataFeature } from "./features/datamgmt/service.js";
import { ChannelsFeature } from "./features/channels/service.js";
import { MaintenanceFeature } from "./features/maintenance/service.js";
import { HostError, type HostServiceEvents } from "./core/shared.js";

// The composition root behind the Host API: the store, the runtimes and the event stream, the helpers every feature
// shares, and one object per feature (features/<name>/). HTTP routes and MCP tools call into the features.

export { HostError, PROPOSALS_PER_ROUND, TERMINAL_TOKEN_ENV, type HostServiceEvents } from "./core/shared.js";

export class HostService extends EventEmitter<HostServiceEvents> {
  /** Studio windows listening to the event socket (the HTTP server counts them): 外部打开 Review needs one. */
  liveWindows = 0;
  readonly projects = new ProjectsFeature(this);
  readonly config = new ConfigFeature(this);
  readonly tasks = new TasksFeature(this);
  readonly topics = new TopicsFeature(this);
  readonly sessions = new SessionsFeature(this);
  readonly planning = new PlanningFeature(this);
  readonly collab = new CollabFeature(this);
  readonly canvases = new CanvasFeature(this);
  readonly review = new ReviewFeature(this);
  readonly extensions = new PacksFeature(this);
  readonly attachments = new AttachmentsFeature(this);
  readonly scratchpad = new ScratchpadFeature(this);
  readonly gitReview = new GitReviewFeature(this);
  readonly files = new FilesFeature(this);
  readonly openIn = new OpenInFeature(this);
  readonly marks = new MarksFeature(this);
  readonly topicDocs = new TopicDocsFeature(this);
  readonly taskPlans = new TaskPlansFeature(this);
  readonly relays = new RelaysFeature(this);
  readonly chatFiles = new ChatFilesFeature(this);
  readonly cli = new CliFeature(this);
  readonly data = new DataFeature(this);
  readonly channels = new ChannelsFeature(this);
  readonly dsh = new DshFeature(this);
  readonly maintenance = new MaintenanceFeature(this);

  constructor(
    readonly store: Store,
    readonly runtime: SessionRuntimeApi,
    readonly profiles: readonly ModelProfile[],
    readonly options: {
      launcher?: TerminalLauncher;
      credentials?: CredentialReader | CredentialStore;
      /** Where the common space lives when it is first made; default `common/` next to the database. */
      commonDir?: string;
      /** The person's Claude Code config dir (设置 → 模型 shows whether it holds a login); default theirs, ~/.claude. */
      localClaudeHome?: string;
      /** The person's own model channels (设置 → 模型); `profiles` is its list. */
      channels?: ChannelRegistry;
      /** DeepSeek on a DSH clone (stage 17): 设置 → 模型 →「检查」 runs through it. */
      dsh?: DshRuntime;
      /** Restarts a Codex profile's app-server so it picks up a channel's new address or key; false while it is busy. */
      restartProfileServer?: (profileId: Id) => Promise<boolean>;
    } = {},
  ) {
    super();
    runtime.on("event", (e) => this.emit("event", e));
    this.tasks.ensureStructure();
  }

  /** The common space: where tasks without a project, the scheduler and topic sessions without a project run. */
  commonWorkspace(): Workspace {
    const ws = this.store.listWorkspaces().find(isCommon);
    if (!ws) throw new HostError("internal", "the common space is missing");
    return ws;
  }

  snapshot(): StateSnapshot {
    return {
      workspaces: this.store.listWorkspaces(),
      topics: this.store.listTopics(),
      tasks: this.store.listTasks(),
      sessions: this.store.listSessions(),
      profiles: [...this.profiles],
      eventSeq: this.store.lastEventSeq(),
    };
  }

  optionalWorkspace(value: unknown): Id | null {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !this.store.getWorkspace(value)) throw new HostError("bad_request", `workspace ${String(value)} not found`);
    return value;
  }

  requireProfile(id: Id): ModelProfile {
    const p = this.profiles.find((x) => x.id === id);
    if (!p) throw new HostError("bad_request", `unknown model profile ${id}`);
    return p;
  }

  requireWorkspace(id: Id): Workspace {
    const ws = this.store.getWorkspace(id);
    if (!ws) throw new HostError("not_found", `workspace ${id} not found`);
    return ws;
  }

  /** A project new work can go to: not archived. */
  requireLiveWorkspace(id: Id): Workspace {
    const ws = this.requireWorkspace(id);
    if (ws.archivedAt) throw new HostError("read_only", `project ${ws.name} is archived`);
    return ws;
  }

  requireTask(id: Id): Task {
    const t = this.store.getTask(id);
    if (!t) throw new HostError("not_found", `task ${id} not found`);
    return t;
  }

  requireTopic(id: Id): Topic {
    const t = this.store.getTopic(id);
    if (!t) throw new HostError("not_found", `topic ${id} not found`);
    return t;
  }

  requireLiveTopic(id: Id): Topic {
    const t = this.requireTopic(id);
    if (t.archivedAt) throw new HostError("read_only", `topic ${t.title} is archived`);
    return t;
  }

  requireSession(id: Id): Session {
    const s = this.store.getSession(id);
    if (!s) throw new HostError("not_found", `session ${id} not found`);
    return s;
  }

  async wrap<T>(fn: () => Promise<T>, fallback: HostErrorCode = "runtime_error"): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HostError) throw err;
      const e = err as { code?: string; message?: string };
      // Runtimes mark the errors that are the caller's (a command Studio refuses, a background command not found).
      const code: HostErrorCode = e.code === "read_only" || e.code === "bad_request" || e.code === "not_found" ? e.code : fallback;
      throw new HostError(code, e.message ?? String(err));
    }
  }

  publish(event: HostEventInput): HostEvent {
    const persisted = this.store.appendEvent(event);
    this.emit("event", persisted);
    return persisted;
  }

  /** A failure outside any request (bin.ts catches it and keeps running): the windows show it once. */
  reportError(err: unknown): void {
    const message = (err instanceof Error ? err.message : String(err)).split(/\r?\n/)[0]!.slice(0, 300);
    try {
      this.publish({ type: "host.error", message });
    } catch {
      // The store itself failed: the log has it.
    }
  }
}
