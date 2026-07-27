import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ensureBrokerStarted } from "./startupBroker";
import { installStartupStatusReplay, publishStartupStatus } from "./startupStatus";
import "./styles.css";

async function renderApplication() {
  const { renderApp } = await import("./renderApp");
  renderApp();
}

async function startMainWindow() {
  await installStartupStatusReplay().catch(() => {
    // Direct browser previews do not expose the native startup window.
  });
  void publishStartupStatus({ module: "interface", state: "loading", message: "Loading frontend" });
  void ensureBrokerStarted().catch(() => {
    // The main application renders the recoverable Broker error state.
  });
  await renderApplication();
  void publishStartupStatus({ module: "interface", state: "ready", message: "Ready" });
}

if (getCurrentWebviewWindow().label === "main") {
  void startMainWindow();
} else {
  void renderApplication();
}
