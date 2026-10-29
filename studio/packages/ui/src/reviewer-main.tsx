import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReviewApp } from "./gitreview/ReviewApp.js";
import { ViewerApp } from "./viewer/ViewerApp.js";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "@fontsource-variable/jetbrains-mono";
// The controls and the review pages' own styles (the cascade order of main.tsx, without the workbench's).
import "./styles/base.css";
import "./styles/markdown.css";
import "./styles/code.css";
import "./shell/shell.css";
import "./task/task.css";
import "./chat/chat.css";
import "./chat/pickers.css";
import "./review/review.css";
import "./settings/settings.css";
import "./gitreview/gitreview.css";
import "./attach/attach.css";
import "./marks/marks.css";
import "./files/files.css";
import "./viewer/viewer.css";
import "./viewpacks/viewpacks.css";
import { applyTheme, followThemeChanges } from "./lib/theme.js";
import { inAmo } from "./lib/where.js";
import { WindowBoundary } from "./lib/ErrorBoundary.js";
import { Toaster } from "./lib/toast.js";

// The review pages' own entry (reviewer.html, 2026-10-23): Git Review (#review) and the viewer with its 查看包
// (#viewer), for the AMO Reviewer program — not Studio's whole workbench.

// In Studio the windows follow Studio's 主题; the AMO Reviewer program alone has its own (2026-10-29), which its main
// process sets as the system colours of its windows — base.css follows those when no theme is forced here.
if (inAmo()) {
  applyTheme();
  followThemeChanges();
} else applyTheme("system");
const viewer = location.hash.startsWith("#viewer");

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <WindowBoundary>
      {viewer ? <ViewerApp /> : <ReviewApp />}
      <Toaster />
    </WindowBoundary>
  </StrictMode>,
);
