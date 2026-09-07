import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { beforeEach } from "node:test";
import ts from "typescript";

// Execute the production window flows against native ports without opening desktop windows.
const calls = [];
const effects = [];
const domListeners = new Map();
const nativeListeners = new Map();
const windows = new Map();
let activeUtility = null;
let currentLabel = "main";
let failShow = false;
function nativeWindow(label) {
  return {
    label,
    async show() { if (failShow) throw new Error("show failed"); calls.push([label, "show"]); },
    async hide() { calls.push([label, "hide"]); },
    async unminimize() { calls.push([label, "unminimize"]); },
    async setFocus() { calls.push([label, "focus"]); },
    async setAlwaysOnTop(value) { calls.push([label, "top", value]); },
    async emitTo(target, event, payload) { calls.push([label, "emit", target, event, payload]); },
    async listen(event, callback) { nativeListeners.set(event, callback); return () => {}; },
    async onCloseRequested(callback) { nativeListeners.set("close", callback); return () => {}; },
    async isVisible() { return true; },
  };
}
const ports = {
  useEffect: (effect) => effects.push(effect),
  useState: (initial) => {
    activeUtility = initial;
    return [initial, (next) => { activeUtility = typeof next === "function" ? next(activeUtility) : next; }];
  },
  getCurrentWindow: () => windows.get(currentLabel),
  getCurrentWebviewWindow: () => ({ label: currentLabel }),
  Window: { getByLabel: async (label) => windows.get(label) ?? null },
  WebviewWindow: class {
    static async getByLabel(label) { return windows.get(label) ?? null; }
    constructor(label, options) {
      calls.push([label, "create", options]);
      const target = nativeWindow(label);
      target.once = async (event, callback) => { if (event === "tauri://created") queueMicrotask(callback); };
      windows.set(label, target);
      return target;
    }
  },
};
globalThis.__canvasWindowTestPorts = ports;
globalThis.window = {
  setTimeout, clearTimeout,
  addEventListener: (event, callback) => domListeners.set(event, callback),
  removeEventListener: (event) => domListeners.delete(event),
};
globalThis.document = { documentElement: { dataset: { amoTheme: "dark" } } };
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
function compile(relativePath, replacements = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return moduleUrl(compiled.replace(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)";/g, (match, bindings, specifier) => {
    if (replacements[specifier]) return `import {${bindings}} from "${replacements[specifier]}";`;
    return `const {${bindings.replace(/\bas\b/g, ":")}} = globalThis.__canvasWindowTestPorts;`;
  }));
}
const utilityUrl = compile("../../src/windows/utilityWindow.ts");
const utility = await import(utilityUrl);
const { useMainUtilityWindows } = await import(compile("../../src/hooks/useMainUtilityWindows.ts", {
  "../windows/utilityWindow": utilityUrl,
}));

beforeEach(() => {
  calls.length = 0;
  effects.length = 0;
  domListeners.clear();
  nativeListeners.clear();
  windows.clear();
  for (const label of ["main", "canvas", "deploy", "settings", "priorities", "harness", "scratchpad"]) {
    windows.set(label, nativeWindow(label));
  }
  currentLabel = "main";
  activeUtility = null;
  failShow = false;
});

test("Canvas open keeps an existing modal utility active and never changes window layers", async () => {
  const hook = useMainUtilityWindows({ setFeedback() {} });
  for (const effect of effects) effect();
  await hook.openSettingsDialog();
  assert.equal(activeUtility, "settings");
  await new Promise((resolve) => setImmediate(resolve));
  calls.length = 0;
  await hook.openCanvasWindow();
  assert.equal(activeUtility, "settings");
  assert.deepEqual(calls, [
    ["canvas", "unminimize"],
    ["canvas", "show"],
    ["canvas", "emit", "canvas", "amo-canvas-visibility", true],
    ["canvas", "focus"],
  ]);
  nativeListeners.get("amo-utility-window-state")({ payload: { label: "canvas", open: true } });
  assert.equal(activeUtility, "settings", "nonmodal labels must be rejected at the event boundary");
  failShow = true;
  await hook.openCanvasWindow();
  assert.equal(activeUtility, "settings", "Canvas failure must not dismiss a modal utility");
});

test("Canvas creation is lazy, coalesced, non-topmost, and available in the taskbar", async () => {
  windows.delete("canvas");
  const hook = useMainUtilityWindows({ setFeedback() {} });
  assert.equal(calls.length, 0);
  await Promise.all([hook.openCanvasWindow(), hook.openCanvasWindow()]);
  const creates = calls.filter((call) => call[1] === "create");
  assert.equal(creates.length, 1);
  assert.equal(creates[0][2].alwaysOnTop, false);
  assert.equal(creates[0][2].skipTaskbar, false);
  assert.equal(activeUtility, null);
});

test("Canvas close hides the draft and sends visibility without affecting main or modal peers", async () => {
  currentLabel = "canvas";
  await utility.closeUtilityWindow("canvas");
  assert.deepEqual(calls, [
    ["canvas", "hide"],
    ["canvas", "emit", "canvas", "amo-canvas-visibility", false],
  ]);
});

test("Canvas lifecycle preserves Escape for interactions but prevents destructive native close", async () => {
  currentLabel = "canvas";
  utility.useUtilityWindowLifecycle("canvas");
  for (const effect of effects) effect();
  assert.equal(domListeners.has("keydown"), false);
  let prevented = false;
  nativeListeners.get("close")({ preventDefault() { prevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.ok(calls.some((call) => call[0] === "canvas" && call[1] === "hide"));
});

test("existing utility Escape and layer coordination remain modal and leave Canvas alone", async () => {
  currentLabel = "settings";
  const settingsUtility = await import(`${utilityUrl}#settings`);
  settingsUtility.useUtilityWindowLifecycle("settings");
  for (const effect of effects) effect();
  let prevented = false;
  domListeners.get("keydown")({ key: "Escape", preventDefault() { prevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.ok(calls.some((call) => call[0] === "main" && call[1] === "top" && call[2] === true));
  calls.length = 0;
  await settingsUtility.bringUtilityWindowToFront("deploy");
  assert.ok(calls.some((call) => call[0] === "main" && call[1] === "top" && call[2] === false));
  assert.equal(calls.some((call) => call[0] === "canvas"), false);
});

test("Canvas has a lazy route, native permission, and native close guard before React loads", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../../src/App.tsx"), /canvas: lazy\(\(\) => import\("\.\/windows\/CanvasWorkbenchApp"\)/);
  const capabilities = JSON.parse(read("../../src-tauri/capabilities/default.json"));
  assert.ok(capabilities.windows.includes("canvas"));
  assert.match(read("../../src-tauri/src/lib.rs"), /window.label\(\) == "canvas"[\s\S]*?api.prevent_close\(\)[\s\S]*?window.hide\(\)[\s\S]*?emit_to\("canvas", "amo-canvas-visibility", false\)/);
});
