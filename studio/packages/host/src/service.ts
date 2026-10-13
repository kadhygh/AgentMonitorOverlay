import { EventEmitter } from "node:events";
import type { HostErrorCode, HostEvent, Id, ModelProfile, Session, StateSnapshot, Task, Topic, Workspace } from "@amo-studio/protocol";
import { isCommon } from "@amo-studio/protocol";
import { type HostEventInput, type Store } from "./store/store.js";
import type { SessionRuntimeApi } from "./runtime/runtime.js";
import type { CredentialReader, CredentialStore } from "./runtime/credentials.js";
import type { TerminalLauncher } from "./terminal/launcher.js";
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
import { HostError, type HostServiceEvents } from "./core/shared.js";

// The composition root behind the Host API: the store, the runtimes and the event stream, the helpers every feature
// shares, and one object per feature (features/<name>/). HTTP routes and MCP tools call into the features.

export { HostError, PROPOSALS_PER_ROUND, TERMINAL_TOKEN_ENV, type HostServiceEvents } from "./core/shared.js";

export class HostService extends EventEmitter<HostServiceEvents> {
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

  constructor(
    readonly store: Store,
    readonly runtime: SessionRuntimeApi,
    readonly profiles: readonly ModelProfile[],
    readonly options: {
      launcher?: TerminalLauncher;
      credentials?: CredentialReader | CredentialStore;
      /** Where the common space lives when it is first made; default `common/` next to the database. */
      commonDir?: string;
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
      throw new HostError(e.code === "read_only" ? "read_only" : fallback, e.message ?? String(err));
    }
  }

  publish(event: HostEventInput): HostEvent {
    const persisted = this.store.appendEvent(event);
    this.emit("event", persisted);
    return persisted;
  }
}
