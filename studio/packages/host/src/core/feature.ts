import type { Id, ModelProfile, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import type { HostEventInput, Store } from "../store/store.js";
import type { SessionRuntimeApi } from "../runtime/runtime.js";
import type { HostService } from "../service.js";
import type { TeamLink } from "./teamlink.js";
import type { HostErrorCode } from "@amo-studio/protocol";

/**
 * The features HostService holds, by the name it holds them under (service.ts checks this list against its fields).
 * A feature names the ones it uses in `Feature<…>` (plans/host-structure.md 8c, 2026-11-06).
 */
export type FeatureName =
  | "projects"
  | "config"
  | "claudeAccounts"
  | "tasks"
  | "topics"
  | "sessions"
  | "planning"
  | "collab"
  | "canvases"
  | "canvasReview"
  | "review"
  | "promptTemplates"
  | "mcp"
  | "attachments"
  | "scratchpad"
  | "gitReview"
  | "viewPacks"
  | "files"
  | "openIn"
  | "marks"
  | "topicDocs"
  | "taskPlans"
  | "relays"
  | "chatFiles"
  | "cli"
  | "data"
  | "stats"
  | "channels"
  | "dsh"
  | "maintenance"
  | "remote"
  | "teamRelay"
  | "issues"
  | "duty";

/** The Host without its features: the store, the runtimes, the event stream and the helpers every feature shares. */
export type HostCore = Omit<HostService, FeatureName>;

/**
 * The Host as a feature (or a part of one, or a module of its folder) may use it: its core, and the features `D` it
 * declared. Modules of a feature's folder that need other features take this instead of HostService, so what they
 * use is declared too (src/features/feature-deps.test.ts reads the declarations).
 */
export type FeatureHost<D extends FeatureName = never> = HostCore & Pick<HostService, D>;

/**
 * Base of every feature (features/<name>/service.ts): the shared store, runtime and helpers through the Host, and the
 * other features it declared in `D` as `this.f.<name>` for the calls that cross a feature's edge. Declaring a new one
 * is checked by src/features/feature-deps.test.ts (the dependency graph, and no new cycles).
 */
export abstract class Feature<D extends FeatureName = never> {
  constructor(protected readonly host: FeatureHost<D>) {}

  get store(): Store {
    return this.host.store;
  }
  get runtime(): SessionRuntimeApi {
    return this.host.runtime;
  }
  get profiles(): readonly ModelProfile[] {
    return this.host.profiles;
  }
  protected get options(): HostService["options"] {
    return this.host.options;
  }
  /** The AMO platform's login and this computer's device, to speak to the team server (core/teamlink.ts). */
  protected get teamLink(): TeamLink {
    return this.host.teamLink;
  }
  /** The other features this one declared (`D`). */
  protected get f(): Pick<HostService, D> {
    return this.host;
  }

  publish(event: HostEventInput) {
    return this.host.publish(event);
  }
  protected wrap<T>(fn: () => Promise<T>, fallback?: HostErrorCode): Promise<T> {
    return this.host.wrap(fn, fallback);
  }
  /** A line for host.log. */
  protected log(line: string): void {
    this.host.log(line);
  }
  commonWorkspace(): Workspace {
    return this.host.commonWorkspace();
  }
  protected optionalWorkspace(value: unknown): Id | null {
    return this.host.optionalWorkspace(value);
  }
  protected requireProfile(id: Id): ModelProfile {
    return this.host.requireProfile(id);
  }
  protected requireWorkspace(id: Id): Workspace {
    return this.host.requireWorkspace(id);
  }
  protected requireLiveWorkspace(id: Id): Workspace {
    return this.host.requireLiveWorkspace(id);
  }
  protected requireTask(id: Id): Task {
    return this.host.requireTask(id);
  }
  requireTopic(id: Id): Topic {
    return this.host.requireTopic(id);
  }
  protected requireLiveTopic(id: Id): Topic {
    return this.host.requireLiveTopic(id);
  }
  requireSession(id: Id): Session {
    return this.host.requireSession(id);
  }
}
