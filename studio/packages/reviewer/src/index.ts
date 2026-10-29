// The Reviewer's windows (Git Review, the viewer with its 查看包), as AMO Studio and the AMO Reviewer program both
// open them (2026-10-23: the Reviewer split out of Studio, plans/reviewer-standalone.md).
export { reviewHash, setupReviewWindows, type ReviewWindowOptions } from "./review-window.js";
export { setupViewerWindows, type ViewerWindowOptions } from "./viewer-window.js";
export { installWindowControls, sendMaximized } from "./window-controls.js";
