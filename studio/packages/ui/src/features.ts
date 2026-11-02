import type { AnyViewDef, BoardPanel } from "./shell/views.js";
import { boardView } from "./board/view.js";
import { canvasView } from "./canvas/view.js";
import { panoramaView } from "./panorama/view.js";
import { newTaskView } from "./newtask/view.js";
import { taskView } from "./task/view.js";
import { proposalsPanel } from "./planning/view.js";

// The UI's features, mirroring the Host's (host/src/features/index.ts): each folder declares its pages and panels in
// a view.tsx, and they are put together here. The top bar's tabs follow this order.

/** Panels shown above the board, in order. */
export const BOARD_PANELS: readonly BoardPanel[] = [proposalsPanel];

// 全景 (2026-11-01) after the canvas; it is a 测试功能, so its tab is there only while turned on.
export const VIEWS: readonly AnyViewDef[] = [boardView(BOARD_PANELS), canvasView, panoramaView, newTaskView, taskView];
