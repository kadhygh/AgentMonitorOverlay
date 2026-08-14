export interface StartupCoordinatorOptions {
  ensureRuntime(reason: string): Promise<void>;
  hydrateData(reason: string): Promise<void>;
  onStart?(reason: string): void;
  onSettled?(reason: string): void;
}

export class StartupCoordinator {
  private activeRequest: Promise<void> | null = null;

  constructor(private readonly options: StartupCoordinatorOptions) {}

  start(reason = "startup") {
    if (this.activeRequest) return this.activeRequest;
    this.options.onStart?.(reason);
    const request = this.run(reason).finally(() => {
      if (this.activeRequest === request) this.activeRequest = null;
      this.options.onSettled?.(reason);
    });
    this.activeRequest = request;
    return request;
  }

  active() {
    return this.activeRequest !== null;
  }

  private async run(reason: string) {
    let runtimeError: unknown = null;
    try {
      await this.options.ensureRuntime(reason);
    } catch (error) {
      runtimeError = error;
    }

    // Hydration remains worth attempting when runtime startup reports an error:
    // another AMO/Broker process may already own the endpoint.
    try {
      await this.options.hydrateData(reason);
    } catch (dataError) {
      throw dataError;
    }
    if (runtimeError) throw runtimeError;
  }
}
