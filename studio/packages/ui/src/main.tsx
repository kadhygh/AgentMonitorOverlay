import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { FocusApp } from "./focus/FocusApp.js";
import { ScratchpadApp } from "./scratchpad/ScratchpadApp.js";
import { ReviewApp } from "./gitreview/ReviewApp.js";
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
import { applyTheme, followThemeChanges } from "./lib/theme.js";

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

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<StrictMode>{focus ? <FocusApp /> : scratchpad ? <ScratchpadApp /> : review ? <ReviewApp /> : <App />}</StrictMode>);
