import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { FocusApp } from "./focus/FocusApp.js";
import { BotApp } from "./focus/BotApp.js";
import { ScratchpadApp } from "./scratchpad/ScratchpadApp.js";
import { ReviewApp } from "./gitreview/ReviewApp.js";
import { MarksApp } from "./marks/MarksApp.js";
import { ViewerApp } from "./viewer/ViewerApp.js";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "@fontsource-variable/jetbrains-mono";
// Styles live with their features; one bundle, so the order here is the cascade: base first, then the features.
import "./styles/base.css";
import "./styles/markdown.css";
import "./styles/code.css";
import "./shell/shell.css";
import "./board/board.css";
import "./board/nav.css";
import "./newtask/newtask.css";
import "./task/task.css";
import "./chat/chat.css";
import "./chat/pickers.css";
import "./chat/options.css";
import "./review/review.css";
import "./canvas/canvas.css";
import "./collab/collab.css";
import "./packs/packs.css";
import "./planning/planning.css";
import "./settings/settings.css";
import "./scratchpad/scratchpad.css";
import "./gitreview/gitreview.css";
import "./attach/attach.css";
import "./marks/marks.css";
import "./files/files.css";
import "./chat/questions/questions.css";
import "./chat/cli/cli.css";
import "./viewer/viewer.css";
import "./viewpacks/viewpacks.css";
import "./taskplans/taskplans.css";
import "./relays/relays.css";
import { applyTheme, followThemeChanges } from "./lib/theme.js";
import { WindowBoundary } from "./lib/ErrorBoundary.js";
import { Toaster } from "./lib/toast.js";
import { BookmarkNotePrompt } from "./marks/NotePrompt.js";
import { startResizeTrace, traceFocusInput } from "./lib/resizeTrace.js";

// One bundle, two windows: the workbench, and the Focus window (loaded with #focus).
const focus = location.hash === "#focus";
// The Git Review window (#review?workspace=…).
const review = location.hash.startsWith("#review");
// The saved theme before the first paint; the other window's changes follow.
applyTheme();
followThemeChanges();
if (focus) document.documentElement.classList.add("focus-mode");
// The scratchpad window (便签) is the third, loaded with #scratchpad.
const scratchpad = location.hash === "#scratchpad";
if (scratchpad) document.documentElement.classList.add("scratchpad-mode");

// The file marks window (文件标记, S12-D), loaded with #marks?workspace=….
const marks = location.hash.startsWith("#marks");
// The viewer window (查看器, stage 13), loaded with #viewer?path=….
const viewer = location.hash.startsWith("#viewer");
// The angry robot flying about the screen (2026-10-15 evening), loaded with #bot.
const bot = location.hash === "#bot";
if (bot) document.documentElement.classList.add("bot-mode");

// Each window drag, summarised into logs/resize-trace.log (2026-10-15: the main window flickered when dragged).
startResizeTrace();
if (focus) traceFocusInput();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <WindowBoundary>
      {focus ? <FocusApp /> : bot ? <BotApp /> : scratchpad ? <ScratchpadApp /> : review ? <ReviewApp /> : marks ? <MarksApp /> : viewer ? <ViewerApp /> : <App />}
      <Toaster />
      <BookmarkNotePrompt />
    </WindowBoundary>
  </StrictMode>,
);
