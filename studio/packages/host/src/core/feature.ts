import type { Id, ModelProfile, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import type { HostEventInput, Store } from "../store/store.js";
import type { SessionRuntimeApi } from "../runtime/runtime.js";
import type { HostService } from "../service.js";
import type { HostErrorCode } from "@amo-studio/protocol";

/**
 * Base of every feature (features/<name>/service.ts): the shared store, runtime and helpers through the Host, and the
 * other features as `this.f.<name>` for the few calls that cross a feature's edge.
 */
export abstract class Feature {
  constructor(protected readonly host: HostService) {}

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
  /** The other features. */
  protected get f(): HostService {
    return this.host;
  }

  publish(event: HostEventInput) {
    return this.host.publish(event);
  }
  protected wrap<T>(fn: () => Promise<T>, fallback?: HostErrorCode): Promise<T> {
    return this.host.wrap(fn, fallback);
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
