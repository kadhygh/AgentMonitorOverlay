export const ANNO_REGEX = /\[!anno\]([\s\S]*?)\[\/anno\]/gi;
export const ANNO_TAG_PREFIX = "[!anno]";
export const ANNO_TAG_SUFFIX = "[/anno]";
export const EMPTY_ANNO_TEXT = "(empty annotation)";
export const ANNOTATION_DEFAULT_LABEL = "批注";
export const PLUGIN_VERSION = "1.4.9";
export const DEFAULT_SETTINGS = {
  bridgeUrl: "http://127.0.0.1:17654",
  numberAnnotationsInPrompt: false,
  canvasAppendDirection: "down",
};
export const AMO_PANEL_VIEW_TYPE = "amo-annotation-panel";
export const AMO_OPEN_PROTOCOL = "amo-open";
export const AMO_SEND_ACTION_CLASS = "amo-send-note-action";
export const AMO_PANEL_ACTION_CLASS = "amo-open-panel-action";
export const AMO_CANVAS_SEND_ACTION_CLASS = "amo-send-canvas-note-action";
export const AMO_CANVAS_PANEL_ACTION_CLASS = "amo-open-canvas-panel-action";
export const DEFAULT_CANVAS_PATH = "AgentFlow.canvas";
export const SKIPPED_TAGS = new Set(["A", "BUTTON", "CODE", "INPUT", "PRE", "SCRIPT", "STYLE", "TEXTAREA"]);
