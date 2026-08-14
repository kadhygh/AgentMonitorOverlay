import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { installStartupStatusReplay, publishStartupStatus } from "./startupStatus";
import { recordStartupMilestone } from "./startupDiagnostics";
import "./styles.css";

async function renderApplication() {
  const { renderApp } = await import("./renderApp");
  renderApp();
}

async function startMainWindow() {
  void installStartupStatusReplay().catch(() => {
    // Direct browser previews do not expose the native startup window.
  });
  void publishStartupStatus({ module: "interface", state: "loading", message: "Loading frontend" });
  await renderApplication();
  void publishStartupStatus({ module: "interface", state: "ready", message: "Ready" });
}

if (getCurrentWebviewWindow().label === "main") {
  void recordStartupMilestone("mainHtmlReady");
  void startMainWindow();
} else {
  void renderApplication();
}
