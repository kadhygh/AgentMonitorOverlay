import type { AnyViewDef, BoardPanel } from "./shell/views.js";
import { boardView } from "./board/view.js";
import { canvasView } from "./canvas/view.js";
import { packsView } from "./packs/view.js";
import { newTaskView } from "./newtask/view.js";
import { taskView } from "./task/view.js";
import { proposalsPanel } from "./planning/view.js";
import { remoteView } from "./remote/view.js";

// The UI's features, mirroring the Host's (host/src/features/index.ts): each folder declares its pages and panels in
// a view.tsx, and they are put together here. The top bar's tabs follow this order.

/** Panels shown above the board, in order. */
export const BOARD_PANELS: readonly BoardPanel[] = [proposalsPanel];

export const VIEWS: readonly AnyViewDef[] = [boardView(BOARD_PANELS), canvasView, packsView, newTaskView, taskView, remoteView];
