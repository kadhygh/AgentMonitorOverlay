export const ANNO_REGEX = /\[!anno\]([\s\S]*?)\[\/anno\]/gi;
export const ANNO_TAG_PREFIX = "[!anno]";
export const ANNO_TAG_SUFFIX = "[/anno]";
export const EMPTY_ANNO_TEXT = "(empty annotation)";
export const ANNOTATION_DEFAULT_LABEL = "批注";
export const PLUGIN_VERSION = "1.4.38";
export const AMO_CANVAS_MANAGER = "agent-monitor-overlay";
export const AMO_CANVAS_TYPE = "agent-flow-base";
export const DEFAULT_SETTINGS = {
  bridgeUrl: "http://127.0.0.1:17654",
  numberAnnotationsInPrompt: false,
  safeCliPaste: true,
  contextMouseShortcutEnabled: false,
  contextMouseShortcutButton: "mouse5",
  contextMouseShortcutRequireCtrl: true,
  canvasAppendDirection: "down",
  hideAmoNoteProperties: true,
  interceptLocalCodeLinks: true,
  localCodeLinkEditor: "vscode",
  localCodeLinkUrlTemplate: "vscode://file/{path}:{line}",
  zedCommand: "zed",
  workCanvasFolder: "Canvases/work",
};
export const AMO_PANEL_VIEW_TYPE = "amo-annotation-panel";
export const AMO_OPEN_PROTOCOL = "amo-open";
export const AMO_SEND_ACTION_CLASS = "amo-send-note-action";
export const AMO_PANEL_ACTION_CLASS = "amo-open-panel-action";
export const AMO_TITLE_ACTION_CLASS = "amo-edit-note-title-action";
export const AMO_NOTE_PROPERTIES_ACTION_CLASS = "amo-toggle-note-properties-action";
export const AMO_CANVAS_SEND_ACTION_CLASS = "amo-send-canvas-note-action";
export const AMO_CANVAS_PANEL_ACTION_CLASS = "amo-open-canvas-panel-action";
export const AMO_CANVAS_TITLE_ACTION_CLASS = "amo-edit-canvas-note-title-action";
export const AMO_CANVAS_OPEN_NOTE_ACTION_CLASS = "amo-open-canvas-note-action";
export const DEFAULT_CANVAS_PATH = "Canvases/AgentFlow.base.canvas";
export const SKIPPED_TAGS = new Set(["A", "BUTTON", "CODE", "INPUT", "PRE", "SCRIPT", "STYLE", "TEXTAREA"]);
