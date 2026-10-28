import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PlatformApp } from "./platform/PlatformApp.js";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "@fontsource-variable/jetbrains-mono";
// Studio's tokens and controls (buttons, fields), then the platform's own styles.
import "./styles/base.css";
import "./shell/shell.css";
import "./platform/platform.css";
import { applyTheme, followThemeChanges } from "./lib/theme.js";
import { WindowBoundary } from "./lib/ErrorBoundary.js";

// AMO 平台's page (platform.html, 2026-10-28), served by packages/platform on amo-platform://app/.

applyTheme();
followThemeChanges();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <WindowBoundary>
      <PlatformApp />
    </WindowBoundary>
  </StrictMode>,
);
