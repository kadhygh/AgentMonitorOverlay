import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  ExternalLink,
  FlaskConical,
  LoaderCircle,
  Play,
  RefreshCw,
  Server,
  Square,
  Wrench,
  X,
} from "lucide-react";
import {
  checkHarnessLabRemoteVersion,
  installHarnessLabRuntime,
  loadHarnessLabStatus,
  openHarnessLabWeb,
  startHarnessLabService,
  stopHarnessLabService,
  updateHarnessLabRuntime,
  type HarnessLabStatus,
} from "../native/deepseekHarness";
import { AdaptivePollController } from "../runtime/adaptivePollController";
import { useAmoThemeRuntime } from "../theme/amoTheme";
import {
  closeUtilityWindow,
  startUtilityWindowDrag,
  useUtilityWindowLifecycle,
} from "./utilityWindow";

type HarnessAction = "install" | "checkVersion" | "update" | "start" | "stop" | "open" | "refresh";

const stateLabels: Record<string, string> = {
  notInstalled: "Not installed",
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  portConflict: "Port conflict",
  error: "Error",
};

export function HarnessLabApp() {
  useUtilityWindowLifecycle("harness");
  useAmoThemeRuntime();
  const [status, setStatus] = useState<HarnessLabStatus | null>(null);
  const [busy, setBusy] = useState<HarnessAction | null>(null);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState("Loading DeepSeek Harness Lab status...");
  const busyRef = useRef<HarnessAction | null>(null);
  const lastStatusAtRef = useRef(0);
  const loadingRequestRef = useRef(0);
  const statusStateRef = useRef<string | null>(null);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const refreshStatus = useCallback(async (showBusy = true, showLoading = false) => {
    const loadingRequest = showLoading ? ++loadingRequestRef.current : 0;
    if (showBusy) setBusy("refresh");
    if (showLoading) {
      setLoading(true);
      setFeedback("Loading DeepSeek Harness Lab status...");
    }
    try {
      const next = await loadHarnessLabStatus();
      statusStateRef.current = next.state;
      setStatus(next);
      setFeedback(next.message);
      lastStatusAtRef.current = Date.now();
    } catch (error) {
      setFeedback(`Harness status failed: ${(error as Error).message}`);
    } finally {
      if (showBusy) setBusy(null);
      if (showLoading && loadingRequest === loadingRequestRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlistenFocus: (() => void) | null = null;
    let initialStatusStarted = false;
    let initialStatusTimeout: number | null = null;
    const pollController = new AdaptivePollController({
      nextDelayMs: () => {
        const state = statusStateRef.current;
        if (state === "running" || state === "starting") return 3_000;
        if (state === "stopped" || state === "notInstalled") return 15_000;
        return 8_000;
      },
      run: async (reason) => {
        if (busyRef.current) return;
        await refreshStatus(false, reason === "startup");
      },
    });
    const initialStatusFrame = window.requestAnimationFrame(() => {
      initialStatusTimeout = window.setTimeout(() => {
        if (disposed) return;
        initialStatusStarted = true;
        pollController.start("startup");
      }, 0);
    });

    void getCurrentWindow()
      .onFocusChanged((event) => {
        const activityChanged = pollController.setActive(event.payload, "focus-resume");
        if (!event.payload || activityChanged || busyRef.current || !initialStatusStarted) return;
        const statusIsStale = Date.now() - lastStatusAtRef.current > 2_000;
        if (statusIsStale) pollController.request("focus-stale");
      })
      .then((handler) => {
        if (disposed) handler();
        else unlistenFocus = handler;
      });

    return () => {
      disposed = true;
      pollController.stop();
      unlistenFocus?.();
      window.cancelAnimationFrame(initialStatusFrame);
      if (initialStatusTimeout !== null) window.clearTimeout(initialStatusTimeout);
    };
  }, [refreshStatus]);

  async function runStatusAction(action: Exclude<HarnessAction, "open" | "refresh">) {
    setBusy(action);
    try {
      const next = action === "install"
        ? await installHarnessLabRuntime()
        : action === "checkVersion"
          ? await checkHarnessLabRemoteVersion()
          : action === "update"
            ? await updateHarnessLabRuntime()
        : action === "start"
          ? await startHarnessLabService()
           : await stopHarnessLabService();
      statusStateRef.current = next.state;
      setStatus(next);
      setFeedback(next.message);
    } catch (error) {
      setFeedback(`Harness ${action} failed: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function openWeb() {
    setBusy("open");
    try {
      const result = await openHarnessLabWeb();
      setFeedback(result.message);
    } catch (error) {
      setFeedback(`Open Harness Web failed: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const state = status?.state || "starting";
  const stateLabel = stateLabels[state] || state;
  const versionBadge = status?.updateAvailable
    ? "Update available"
    : status?.remoteVersion && status?.installedVersion === status.remoteVersion
      ? "Up to date"
      : status?.installed
        ? "Ready"
        : "Missing";

  return (
    <main className="utility-window-shell harness-lab-window-shell">
      <section className="app-dialog harness-lab-dialog" role="dialog" aria-label="DeepSeek Harness Lab">
        <header className="app-dialog-titlebar">
          <div className="app-dialog-title" onPointerDown={startUtilityWindowDrag}>
            <FlaskConical size={16} aria-hidden="true" />
            <div>
              <strong>DeepSeek Harness Lab</strong>
              <span>Independent preview runtime and service controls</span>
            </div>
          </div>
          <button
            type="button"
            className="candidate-close"
            title="Close Harness Lab"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void closeUtilityWindow("harness")}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </header>

        <div className="harness-lab-content">
          {loading ? (
            <div className="harness-loading-view" role="status" aria-live="polite">
              <LoaderCircle size={24} aria-hidden="true" className="is-spinning" />
              <strong>Loading Harness Lab</strong>
              <span>Checking the local runtime and service status...</span>
            </div>
          ) : null}
          <section className={`harness-status-hero is-${state}`} aria-live="polite">
            <div className="harness-status-icon">
              <Activity size={18} aria-hidden="true" />
            </div>
            <div>
              <span>Service status</span>
              <strong>{stateLabel}</strong>
              <p>{status?.message || "Checking the managed runtime and local service."}</p>
            </div>
            <code>{status?.url || "http://127.0.0.1:3080"}</code>
          </section>

          <div className="harness-action-row" aria-label="Harness controls">
            <button
              type="button"
              className="harness-action is-secondary"
              disabled={Boolean(busy || status?.running || !status?.npmAvailable)}
              title={!status?.npmAvailable ? "A system npm is needed by this development-only installer." : undefined}
              onClick={() => void runStatusAction("install")}
            >
              <Wrench size={14} aria-hidden="true" />
              <span>{busy === "install" ? "Installing..." : status?.installed ? "Repair runtime" : "Install runtime"}</span>
            </button>
            <button
              type="button"
              className="harness-action is-primary"
              disabled={Boolean(busy || !status?.installed || status?.running || state === "portConflict")}
              onClick={() => void runStatusAction("start")}
            >
              <Play size={14} aria-hidden="true" />
              <span>{busy === "start" ? "Starting..." : "Start service"}</span>
            </button>
            <button
              type="button"
              className="harness-action is-danger"
              disabled={Boolean(busy || !status?.owned)}
              title={status?.running && !status.owned ? "AMO does not terminate externally-owned services." : undefined}
              onClick={() => void runStatusAction("stop")}
            >
              <Square size={13} aria-hidden="true" />
              <span>{busy === "stop" ? "Stopping..." : "Stop"}</span>
            </button>
            <button
              type="button"
              className="harness-action is-secondary"
              disabled={Boolean(busy || !status?.running)}
              onClick={() => void openWeb()}
            >
              <ExternalLink size={14} aria-hidden="true" />
              <span>Open Web</span>
            </button>
            <button
              type="button"
              className="harness-icon-action"
              disabled={Boolean(busy)}
              title="Refresh status"
              aria-label="Refresh Harness status"
              onClick={() => void refreshStatus()}
            >
              <RefreshCw size={14} aria-hidden="true" className={busy === "refresh" ? "is-spinning" : ""} />
            </button>
          </div>

          <p className="harness-install-note">
            Install / Repair and Update are explicit runtime operations and can take several minutes. Normal Start service never runs npm install or checks the network.
          </p>

          <section className="harness-card-grid" aria-label="Harness runtime details">
            <article className="harness-info-card">
              <header>
                <Server size={14} aria-hidden="true" />
                <strong>Runtime</strong>
                <em className={status?.updateAvailable ? "is-update" : status?.installed ? "is-ready" : ""}>{versionBadge}</em>
              </header>
              <dl>
                <div><dt>Baseline</dt><dd>{status?.expectedVersion || "0.1.0-rc.6"}</dd></div>
                <div><dt>Local</dt><dd className={status?.updateAvailable ? "is-warning" : ""}>{status?.installedVersion || "—"}</dd></div>
                <div><dt>Remote</dt><dd className={status?.updateAvailable ? "is-update" : ""}>{status?.remoteVersion || "Not checked"}</dd></div>
                <div><dt>Node</dt><dd>{status?.nodeVersion || (status?.nodeAvailable ? "Detected" : "Missing")}</dd></div>
                <div><dt>PID</dt><dd>{status?.pid || "—"}</dd></div>
              </dl>
              <div className="harness-version-actions" aria-label="Harness version controls">
                <button
                  type="button"
                  disabled={Boolean(busy || !status?.npmAvailable)}
                  title={!status?.npmAvailable ? "npm is needed to query the package registry." : "Check the latest published npm version"}
                  onClick={() => void runStatusAction("checkVersion")}
                >
                  <RefreshCw size={12} aria-hidden="true" className={busy === "checkVersion" ? "is-spinning" : ""} />
                  <span>{busy === "checkVersion" ? "Checking..." : "Check remote"}</span>
                </button>
                <button
                  type="button"
                  className={status?.updateAvailable ? "is-update" : ""}
                  disabled={Boolean(busy || !status?.installed || status?.running || !status?.npmAvailable)}
                  title={status?.running ? "Stop the Harness service before updating." : "Install the latest published version into AMO's managed runtime"}
                  onClick={() => void runStatusAction("update")}
                >
                  <CloudDownload size={12} aria-hidden="true" />
                  <span>{busy === "update" ? "Updating..." : "Update"}</span>
                </button>
              </div>
            </article>

            <article className="harness-info-card">
              <header>
                <FlaskConical size={14} aria-hidden="true" />
                <strong>Models & credentials</strong>
              </header>
              <div className="harness-readiness-list">
                <span className={status?.deepseekKeyConfigured ? "is-ready" : "is-warning"}>
                  <i /> DeepSeek Key {status?.deepseekKeyConfigured ? "ready" : "missing"}
                </span>
                <span className={status?.glmKeyConfigured ? "is-ready" : "is-warning"}>
                  <i /> GLM Key {status?.glmKeyConfigured ? "ready" : "missing"}
                </span>
                <span className={status?.glmProviderConfigured ? "is-ready" : ""}>
                  <i /> GLM Provider {status?.glmProviderConfigured ? "seeded" : "seeds on first start"}
                </span>
              </div>
              <p>
                Keys are read from AMO's Windows Credential Manager entries and passed only in the Harness process environment.
              </p>
            </article>
          </section>

          <section className="harness-paths" aria-label="Harness paths">
            <div><span>Runtime</span><code title={status?.runtimePath}>{status?.runtimePath || "Detecting..."}</code></div>
            <div><span>DSH_HOME</span><code title={status?.dshHome}>{status?.dshHome || "Detecting..."}</code></div>
          </section>

          <section className={`harness-log-panel${logsExpanded ? " is-expanded" : ""}`}>
            <button
              type="button"
              className="harness-log-toggle"
              aria-expanded={logsExpanded}
              aria-controls="harness-service-logs"
              onClick={() => setLogsExpanded((current) => !current)}
            >
              {logsExpanded
                ? <ChevronDown size={13} aria-hidden="true" />
                : <ChevronRight size={13} aria-hidden="true" />}
              <strong>Service logs</strong>
              <span>Read-only diagnostics</span>
              <em>{logsExpanded ? "Collapse" : "Show"}</em>
            </button>
            {logsExpanded ? (
              <pre id="harness-service-logs" aria-label="Read-only Harness service logs">
                {status?.recentLog || "No Harness service logs yet."}
              </pre>
            ) : null}
          </section>
        </div>

        <footer className="app-dialog-footer">
          <span title={feedback}>{feedback}</span>
        </footer>
      </section>
    </main>
  );
}
