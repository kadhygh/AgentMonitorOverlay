import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Blocks,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  Cpu,
  ExternalLink,
  FlaskConical,
  FolderCog,
  KeyRound,
  LoaderCircle,
  PackageCheck,
  PanelTop,
  Play,
  RefreshCw,
  Search,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  checkHarnessRemoteVersion,
  installGlobalHarness,
  loadHarnessLabStatus,
  openHarnessLabWeb,
  startGlobalHarnessWeb,
  stopGlobalHarnessWeb,
  updateGlobalHarness,
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
  notInstalled: "Unavailable",
  stopped: "Stopped",
  running: "Running",
  portConflict: "Port conflict",
  installationBroken: "Installation issue",
  error: "Error",
};

export function HarnessLabApp() {
  useUtilityWindowLifecycle("harness");
  useAmoThemeRuntime();
  const [status, setStatus] = useState<HarnessLabStatus | null>(null);
  const [busy, setBusy] = useState<HarnessAction | null>(null);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState("Loading DeepSeek Harness status...");
  const busyRef = useRef<HarnessAction | null>(null);
  const lastStatusAtRef = useRef(0);
  const loadingRequestRef = useRef(0);
  const statusStateRef = useRef<string | null>(null);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const applyStatus = useCallback((next: HarnessLabStatus) => {
    statusStateRef.current = next.state;
    setStatus(next);
    setFeedback(next.message);
    lastStatusAtRef.current = Date.now();
  }, []);

  const refreshStatus = useCallback(async (showBusy = true, showLoading = false) => {
    const loadingRequest = showLoading ? ++loadingRequestRef.current : 0;
    if (showBusy) setBusy("refresh");
    if (showLoading) {
      setLoading(true);
      setFeedback("Loading DeepSeek Harness status...");
    }
    try {
      applyStatus(await loadHarnessLabStatus());
    } catch (error) {
      setFeedback(`Harness status failed: ${(error as Error).message}`);
    } finally {
      if (showBusy) setBusy(null);
      if (showLoading && loadingRequest === loadingRequestRef.current) {
        setLoading(false);
      }
    }
  }, [applyStatus]);

  useEffect(() => {
    let disposed = false;
    let unlistenFocus: (() => void) | null = null;
    let initialStatusStarted = false;
    let initialStatusTimeout: number | null = null;
    const pollController = new AdaptivePollController({
      nextDelayMs: () => {
        if (statusStateRef.current === "running") return 3_000;
        return 15_000;
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
        if (Date.now() - lastStatusAtRef.current > 2_000) pollController.request("focus-stale");
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
        ? await installGlobalHarness()
        : action === "checkVersion"
          ? await checkHarnessRemoteVersion()
          : action === "update"
            ? await updateGlobalHarness()
            : action === "start"
              ? await startGlobalHarnessWeb()
              : await stopGlobalHarnessWeb();
      applyStatus(next);
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

  const state = status?.state || "notInstalled";
  const stateLabel = stateLabels[state] || state;
  const versionBadge = status?.installedAhead
    ? "Ahead of registry"
    : status?.updateAvailable
      ? "Update available"
      : status?.remoteVersion && status?.installedVersion === status.remoteVersion
        ? "Up to date"
        : status?.installed
          ? "Installed"
          : "Missing";
  const canStartWeb = Boolean(status?.installed && !status.running && state !== "portConflict" && state !== "installationBroken");
  const webAddress = status?.running
    ? `${status.url} · PID ${status.pid || "detecting"}`
    : status?.installed
      ? "Global DSH remains installed · Web process is not running"
      : "Install global DSH to enable its Web interface";

  return (
    <main className="utility-window-shell harness-lab-window-shell">
      <section className="app-dialog harness-lab-dialog" role="dialog" aria-label="Harness Lab">
        <header className="app-dialog-titlebar">
          <div className="app-dialog-title" onPointerDown={startUtilityWindowDrag}>
            <FlaskConical size={16} aria-hidden="true" />
            <div>
              <strong>Harness Lab</strong>
              <span>Global DSH installation and Web control</span>
            </div>
          </div>
          <div className="harness-title-meta">
            <span>Global command</span>
            <code>dsh {status?.installedVersion || "—"}</code>
            <button
              type="button"
              className="candidate-close"
              title="Close Harness Lab"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => void closeUtilityWindow("harness")}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="harness-lab-content">
          {loading ? (
            <div className="harness-loading-view" role="status" aria-live="polite">
              <LoaderCircle size={24} aria-hidden="true" className="is-spinning" />
              <strong>Loading Harness Lab</strong>
              <span>Checking the global command and local Web interface...</span>
            </div>
          ) : null}

          <section className={`harness-web-status is-${state}`} aria-live="polite">
            <div className="harness-web-main">
              <div className="harness-web-icon">
                <PanelTop size={18} aria-hidden="true" />
              </div>
              <div className="harness-web-copy">
                <span>Web interface</span>
                <strong>{stateLabel}</strong>
                <small title={webAddress}>{webAddress}</small>
              </div>
            </div>
            <div className="harness-web-actions">
              <button
                type="button"
                className="harness-action is-primary"
                disabled={Boolean(busy || !status?.running)}
                onClick={() => void openWeb()}
              >
                <ExternalLink size={14} aria-hidden="true" />
                <span>{busy === "open" ? "Opening..." : "Open Web"}</span>
              </button>
              <button
                type="button"
                className="harness-action"
                disabled={Boolean(busy || !canStartWeb)}
                title={state === "portConflict" ? "Port 3080 is occupied by another service." : "Start the globally installed DSH Web interface"}
                onClick={() => void runStatusAction("start")}
              >
                <Play size={14} aria-hidden="true" />
                <span>{busy === "start" ? "Starting..." : "Start Web"}</span>
              </button>
              <button
                type="button"
                className="harness-action is-danger"
                disabled={Boolean(busy || !status?.running)}
                title="Stop only the verified global DSH Web process"
                onClick={() => void runStatusAction("stop")}
              >
                <Square size={13} aria-hidden="true" />
                <span>{busy === "stop" ? "Stopping..." : "Stop Web"}</span>
              </button>
              <button
                type="button"
                className="harness-icon-action"
                disabled={Boolean(busy)}
                title="Refresh Harness status"
                aria-label="Refresh Harness status"
                onClick={() => void refreshStatus()}
              >
                <RefreshCw size={14} aria-hidden="true" className={busy === "refresh" ? "is-spinning" : ""} />
              </button>
            </div>
          </section>

          <section className="harness-installation-row" aria-label="Global DSH installation">
            <div className="harness-installation-main">
              <div className="harness-installation-icon">
                <SquareTerminal size={17} aria-hidden="true" />
              </div>
              <div className="harness-installation-copy">
                <span>Global installation</span>
                <div>
                  <strong>DeepSeek Harness {status?.installedVersion || "not installed"}</strong>
                  <em className={status?.updateAvailable ? "is-update" : status?.installed ? "is-ready" : "is-missing"}>{versionBadge}</em>
                </div>
                <small>
                  {status?.installed
                    ? "Available in every terminal and project through the dsh command"
                    : `Recommended version: ${status?.recommendedVersion || "0.1.0-rc.6"}`}
                </small>
              </div>
            </div>
            <div className="harness-installation-actions">
              <button
                type="button"
                className="harness-action"
                disabled={Boolean(busy || status?.running || !status?.npmAvailable)}
                title={!status?.npmAvailable ? "A system npm on PATH is required." : "Install the explicit recommended version globally"}
                onClick={() => void runStatusAction("install")}
              >
                <PackageCheck size={14} aria-hidden="true" />
                <span>{busy === "install" ? "Installing..." : status?.installed ? "Reinstall" : "Install DSH"}</span>
              </button>
              <button
                type="button"
                className="harness-action"
                disabled={Boolean(busy || !status?.npmAvailable)}
                title="Check the published npm version"
                onClick={() => void runStatusAction("checkVersion")}
              >
                <Search size={14} aria-hidden="true" />
                <span>{busy === "checkVersion" ? "Checking..." : "Check remote"}</span>
              </button>
              <button
                type="button"
                className={`harness-action${status?.updateAvailable ? " is-primary" : ""}`}
                disabled={Boolean(busy || status?.running || !status?.npmAvailable || !status?.updateAvailable)}
                title={status?.running ? "Stop Web before updating DSH." : "Install the exact remote version globally"}
                onClick={() => void runStatusAction("update")}
              >
                <CloudDownload size={14} aria-hidden="true" />
                <span>{busy === "update" ? "Updating..." : "Update"}</span>
              </button>
            </div>
          </section>

          <section className="harness-owned-section" aria-labelledby="harness-owned-title">
            <div className="harness-section-heading">
              <strong id="harness-owned-title">Managed inside DSH</strong>
              <span>AMO does not read or rewrite these settings</span>
            </div>
            <div className="harness-owned-grid">
              <HarnessOwnedItem
                icon={<Cpu size={15} aria-hidden="true" />}
                title="Models & Providers"
                detail="Routes, endpoints, and model names"
                disabled={Boolean(busy || !status?.running)}
                onOpen={openWeb}
              />
              <HarnessOwnedItem
                icon={<KeyRound size={15} aria-hidden="true" />}
                title="Credentials"
                detail="Provider keys owned by DSH"
                disabled={Boolean(busy || !status?.running)}
                onOpen={openWeb}
              />
              <HarnessOwnedItem
                icon={<Blocks size={15} aria-hidden="true" />}
                title="Presets & Plugins"
                detail="Agent Presets and profile plugins"
                disabled={Boolean(busy || !status?.running)}
                onOpen={openWeb}
              />
            </div>
          </section>

          <section className={`harness-diagnostics${diagnosticsExpanded ? " is-expanded" : ""}`}>
            <button
              type="button"
              className="harness-diagnostics-toggle"
              aria-expanded={diagnosticsExpanded}
              aria-controls="harness-diagnostics-content"
              onClick={() => setDiagnosticsExpanded((current) => !current)}
            >
              <span>
                <FolderCog size={14} aria-hidden="true" />
                <strong>Installation details</strong>
              </span>
              <em>Paths, toolchain, and logs</em>
              {diagnosticsExpanded
                ? <ChevronDown size={14} aria-hidden="true" />
                : <ChevronRight size={14} aria-hidden="true" />}
            </button>
            {diagnosticsExpanded ? (
              <div className="harness-diagnostics-content" id="harness-diagnostics-content">
                <div className="harness-diagnostics-grid">
                  <div><span>Executable</span><code title={status?.executablePath || undefined}>{status?.executablePath || "Not found"}</code></div>
                  <div><span>Package</span><code title={status?.packageRoot || undefined}>{status?.packageRoot || "Not found"}</code></div>
                  <div><span>npm root</span><code title={status?.npmGlobalRoot || undefined}>{status?.npmGlobalRoot || "Not found"}</code></div>
                  <div><span>DSH_HOME</span><code title={status?.dshHome}>{status?.dshHome || "Detecting..."}</code></div>
                  <div><span>Versions</span><code>recommended {status?.recommendedVersion || "—"} · registry {status?.remoteVersion || "not checked"}</code></div>
                  <div><span>Toolchain</span><code>Node {status?.nodeVersion || "missing"} · npm {status?.npmVersion || "missing"} · pnpm {status?.pnpmVersion || "missing"}</code></div>
                  <div><span>Command paths</span><code>{status?.multipleInstallations ? status.executablePaths.join(" · ") : "Single global DSH installation"}</code></div>
                </div>
                <pre aria-label="Global DSH operation log">{status?.recentLog || "No global DSH installation or Web stop operations yet."}</pre>
              </div>
            ) : null}
          </section>
        </div>

        <footer className="app-dialog-footer harness-lab-footer">
          <span title={feedback}>{feedback}</span>
          <em>Process lifecycle: user controlled</em>
        </footer>
      </section>
    </main>
  );
}

function HarnessOwnedItem({
  icon,
  title,
  detail,
  disabled,
  onOpen,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  disabled: boolean;
  onOpen: () => Promise<void>;
}) {
  return (
    <article className="harness-owned-item">
      <span>{icon}</span>
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
      <button type="button" disabled={disabled} onClick={() => void onOpen()}>Open</button>
    </article>
  );
}
