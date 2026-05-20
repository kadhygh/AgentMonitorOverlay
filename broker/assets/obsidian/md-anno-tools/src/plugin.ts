import { MarkdownView, Notice, Plugin } from "obsidian";
import {
  AMO_CANVAS_PANEL_ACTION_CLASS,
  AMO_CANVAS_MANAGER,
  AMO_CANVAS_SEND_ACTION_CLASS,
  AMO_CANVAS_TYPE,
  AMO_OPEN_PROTOCOL,
  AMO_PANEL_ACTION_CLASS,
  AMO_PANEL_VIEW_TYPE,
  AMO_SEND_ACTION_CLASS,
  ANNO_REGEX,
  ANNO_TAG_PREFIX,
  ANNO_TAG_SUFFIX,
  DEFAULT_CANVAS_PATH,
  DEFAULT_SETTINGS,
  PLUGIN_VERSION,
  SKIPPED_TAGS,
} from "./core/constants";
import { fetchJson, joinUrl, postDebugLog, postJson, writeTextToClipboard } from "./core/api";
import { normalizeOpenKind, normalizeVaultFilePath, toVaultRelativeProtocolPath } from "./core/paths";
import { parseAmoFrontmatter } from "./core/metadata";
import { getVaultRoot, getWindowSelectionText, messageFromError, previewText, rootContainsAnnotationMarkers, describeElement } from "./core/ui-utils";
import { AmoAnnotationPanelView } from "./ui/panel-view";
import { AnnotationInputModal, CanvasNoteTargetModal } from "./ui/modals";
import { AmoAnnotationSettingTab } from "./ui/settings-tab";
import {
  buildAnnotationMarkup,
  buildReferencedAnnotationMarkup,
  createAnnotationElement,
  extractAnnotationContents,
  formatAnnotationsForClipboard,
  insertReferencedAnnotation,
  normalizeAnnotationContent,
} from "./annotations/syntax";
import { findLegacyAnnotationBlockForSection, parseLegacyAnnotationBlocks, LegacyAnnotationBlockRenderChild, LegacyAnnotationHiddenSectionRenderChild } from "./annotations/render";
import {
  canvasFilePathFromEventTarget,
  canvasNodeFilePath,
  collectCanvasNodes,
  collectCanvasSelectedNodes,
  normalizeCanvasFilePathCandidate,
} from "./canvas/target";


export class AmoMarkdownAnnotationToolsPlugin extends Plugin {
  settings: any;
  operationStatus: any;
  lastMarkdownView: MarkdownView | null;
  lastMarkdownLeaf: any;
  lastMarkdownFilePath: string | null;
  lastMarkdownTargetSource: string | null;
  lastCanvasView: any;
  canvasViewsWithTargetTracking: WeakSet<any>;
  canvasTargetFilePathByView: WeakMap<any, string>;
  panelRefreshTimer: number | null;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) || {});
    this.operationStatus = {
      tone: "neutral",
      message: "Ready.",
      at: new Date().toISOString(),
    };
    this.lastMarkdownView = null;
    this.lastMarkdownLeaf = null;
    this.lastMarkdownFilePath = null;
    this.lastMarkdownTargetSource = null;
    this.lastCanvasView = null;
    this.canvasViewsWithTargetTracking = new WeakSet();
    this.canvasTargetFilePathByView = new WeakMap();
    this.panelRefreshTimer = null;

    this.registerView(AMO_PANEL_VIEW_TYPE, (leaf) => new AmoAnnotationPanelView(leaf, this));
    this.addSettingTab(new AmoAnnotationSettingTab(this.app, this));
    this.debugLog("plugin.loaded", {
      version: PLUGIN_VERSION,
      bridgeUrl: this.settings.bridgeUrl,
      vaultRoot: getVaultRoot(this.app),
    });

    if (typeof this.registerObsidianProtocolHandler === "function") {
      this.registerObsidianProtocolHandler(AMO_OPEN_PROTOCOL, (params) => {
        void this.handleAmoOpenProtocol(params);
      });
    }

    this.addRibbonIcon("panel-right", "Open AMO annotation panel", () => {
      void this.activatePanel();
    });

    this.addRibbonIcon("send", "Send annotations to AMO", () => {
      void this.sendAnnotationsFromActiveFile();
    });

    this.addRibbonIcon("clipboard-copy", "Copy annotations", () => {
      void this.copyAnnotationsFromActiveFile();
    });

    this.addCommand({
      id: "send-annotations-to-amo",
      name: "Send current note annotations to AMO",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return false;
        if (!checking) void this.sendAnnotationsFromFile(file);
        return true;
      },
    });

    this.addCommand({
      id: "open-amo-annotation-panel",
      name: "Open AMO annotation panel",
      callback: () => {
        void this.activatePanel();
      },
    });

    this.addCommand({
      id: "open-current-note-with-amo-tab-reuse",
      name: "Open current note with AMO tab reuse",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return false;
        if (!checking) void this.openVaultPath(file.path, "note");
        return true;
      },
    });

    this.addCommand({
      id: "open-amo-work-canvas",
      name: "Open AMO work canvas",
      callback: () => {
        void this.openVaultPath(DEFAULT_CANVAS_PATH, "canvas");
      },
    });

    this.addCommand({
      id: "copy-annotations-from-current-note",
      name: "Copy current note annotations",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return false;
        if (!checking) void this.copyAnnotationsFromFile(file);
        return true;
      },
    });

    this.addCommand({
      id: "wrap-selection-with-annotation-tag",
      name: "Insert referenced [!anno] annotation",
      editorCallback: (editor) => {
        this.wrapSelectionWithAnnotation(editor);
      },
    });

    this.addCommand({
      id: "insert-referenced-annotation-from-selection",
      name: "Insert referenced annotation from selection",
      checkCallback: (checking) => {
        const hasEditor = this.canInsertAnnotationAtActiveEditor();
        const hasDomSelection = getWindowSelectionText().length > 0 && Boolean(this.getActiveMarkdownFile());
        if (!hasEditor && !hasDomSelection) return false;
        if (!checking) void this.insertAnnotationFromCurrentSelection();
        return true;
      },
    });

    this.addCommand({
      id: "append-annotation-to-current-note",
      name: "Append annotation to current note",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) return false;
        if (!checking) {
          new AnnotationInputModal(this.app, async (value) => {
            await this.appendAnnotationToFile(file, value);
          }).open();
        }
        return true;
      },
    });

    this.registerMarkdownPostProcessor((el, ctx) => this.renderAnnotations(el, ctx), 1000);

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const hasSelection = editor.getSelection().trim().length > 0;
        menu.addItem((item) => {
          item
            .setTitle(hasSelection ? "Quote selection into [!anno]" : "Insert [!anno] at cursor")
            .setIcon("message-square-plus")
            .onClick(() => {
              this.wrapSelectionWithAnnotation(editor);
            });
        });
      })
    );

    this.app.workspace.onLayoutReady(() => {
      this.rememberCurrentMarkdownView();
      this.syncMarkdownViewActions();
      this.syncCanvasViewActions();
      void this.syncAmoCanvasRendering();
      this.refreshPanels();
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.rememberMarkdownLeaf(leaf);
        this.syncMarkdownViewActions();
        this.syncCanvasViewActions();
        void this.syncAmoCanvasRendering();
        if (!leaf || !leaf.view || typeof leaf.view.getViewType !== "function" || leaf.view.getViewType() !== AMO_PANEL_VIEW_TYPE) {
          this.refreshPanels();
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.rememberCurrentMarkdownView();
        this.syncMarkdownViewActions();
        this.syncCanvasViewActions();
        void this.syncAmoCanvasRendering();
        this.refreshPanels();
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.rememberCurrentMarkdownView();
        this.syncMarkdownViewActions();
        this.syncCanvasViewActions();
        void this.syncAmoCanvasRendering();
        this.refreshPanels();
      })
    );

  }

  onunload() {
    if (this.panelRefreshTimer) {
      window.clearTimeout(this.panelRefreshTimer);
      this.panelRefreshTimer = null;
    }
    document
      .querySelectorAll(
        "." +
          AMO_SEND_ACTION_CLASS +
          ", ." +
          AMO_PANEL_ACTION_CLASS +
          ", ." +
          AMO_CANVAS_SEND_ACTION_CLASS +
          ", ." +
          AMO_CANVAS_PANEL_ACTION_CLASS
      )
      .forEach((el) => el.remove());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activatePanel() {
    let leaf = this.app.workspace.getLeavesOfType(AMO_PANEL_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: AMO_PANEL_VIEW_TYPE, active: true });
    }

    this.app.workspace.revealLeaf(leaf);
    this.refreshPanels();
  }

  refreshPanels() {
    for (const leaf of this.app.workspace.getLeavesOfType(AMO_PANEL_VIEW_TYPE)) {
      const view: any = leaf.view;
      if (view && typeof view.render === "function") {
        view.render();
      }
    }
  }

  schedulePanelRefresh(reason: string) {
    if (this.panelRefreshTimer) {
      window.clearTimeout(this.panelRefreshTimer);
    }

    this.panelRefreshTimer = window.setTimeout(() => {
      this.panelRefreshTimer = null;
      this.debugLog("panel.refresh", {
        reason: reason || "unknown",
      });
      this.refreshPanels();
    }, 80);
  }

  debugLog(event: string, data: any = null) {
    void postDebugLog(joinUrl(this.settings.bridgeUrl, "/api/debug/logs"), {
      source: "obsidian-plugin",
      event,
      data: Object.assign(
        {
          version: PLUGIN_VERSION,
          vaultRoot: getVaultRoot(this.app),
        },
        data || {}
      ),
    });
  }

  async handleAmoOpenProtocol(params) {
    const targetPath = this.resolveProtocolTargetPath(params);
    if (!targetPath) {
      new Notice("AMO open URL is missing a vault-relative path.");
      return;
    }

    const kind = normalizeOpenKind(params && (params.kind || params.target), targetPath);
    const focusNotePath = this.resolveProtocolFocusNotePath(params);
    const opened = await this.openVaultPath(targetPath, kind);
    if (opened && kind === "canvas" && focusNotePath) {
      window.setTimeout(() => {
        void this.refreshCanvasForExplicitOpen(targetPath).finally(() => {
          void this.focusCanvasNoteNode(targetPath, focusNotePath);
        });
      }, 120);
    }
  }

  resolveProtocolTargetPath(params) {
    const rawPath =
      params &&
      (params.relativePath ||
        params.relative_path ||
        params.file ||
        params.notePath ||
        params.note_path ||
        params.canvasPath ||
        params.canvas_path ||
        params.path);
    return normalizeVaultFilePath(toVaultRelativeProtocolPath(rawPath, getVaultRoot(this.app)));
  }

  resolveProtocolFocusNotePath(params) {
    const rawPath =
      params &&
      (params.focusNotePath ||
        params.focus_note_path ||
        params.latestNotePath ||
        params.latest_note_path ||
        params.selectedNotePath ||
        params.selected_note_path);
    return normalizeVaultFilePath(toVaultRelativeProtocolPath(rawPath, getVaultRoot(this.app)));
  }

  async openVaultPath(filePath, kind) {
    const targetPath = normalizeVaultFilePath(filePath);
    if (!targetPath) {
      new Notice("AMO target path is empty.");
      return false;
    }

    const file = this.app.vault.getAbstractFileByPath(targetPath);
    if (!file || typeof file.path !== "string") {
      const message = "AMO target not found: " + targetPath;
      this.setOperationStatus(message, "error");
      new Notice(message);
      return false;
    }

    const existingLeaf = this.findLeafForFilePath(file.path, kind);
    if (existingLeaf) {
      this.app.workspace.revealLeaf(existingLeaf);
      this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
      this.rememberMarkdownLeaf(existingLeaf);
      this.setOperationStatus("Focused open " + kind + ": " + file.path + ".", "success");
      return true;
    }

    const leaf = this.createTabLeaf();
    await leaf.openFile(file as any, { active: true });
    this.app.workspace.revealLeaf(leaf);
    this.rememberMarkdownLeaf(leaf);
    this.setOperationStatus("Opened " + kind + ": " + file.path + ".", "success");
    return true;
  }

  async focusCanvasNoteNode(canvasPath, notePath) {
    const normalizedCanvasPath = normalizeVaultFilePath(canvasPath);
    const normalizedNotePath = normalizeVaultFilePath(notePath);
    if (!normalizedCanvasPath || !normalizedNotePath) return false;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const view = this.getCanvasViewForFilePath(normalizedCanvasPath);
      const node = view ? this.findCanvasNodeForFilePath(view, normalizedNotePath) : null;
      if (view && node) {
        const managedCanvas = await this.isAmoManagedCanvasView(view);
        if (managedCanvas) {
          this.selectCanvasNode(view, node, normalizedNotePath);
        }
        const centered = this.centerCanvasNode(view, node);
        this.rememberCanvasMarkdownFile(view, normalizedNotePath);
        this.debugLog("canvas.focus_note.ok", {
          canvasPath: normalizedCanvasPath,
          notePath: normalizedNotePath,
          attempt,
          managedCanvas,
          centered,
        });
        return true;
      }

      await this.delay(80);
    }

    this.debugLog("canvas.focus_note.not_found", {
      canvasPath: normalizedCanvasPath,
      notePath: normalizedNotePath,
    });
    return false;
  }

  async refreshCanvasForExplicitOpen(canvasPath) {
    const normalizedCanvasPath = normalizeVaultFilePath(canvasPath);
    if (!normalizedCanvasPath) return false;

    const file = this.app.vault.getAbstractFileByPath(normalizedCanvasPath);
    if (!file || typeof file.path !== "string") return false;

    const view = this.getCanvasViewForFilePath(normalizedCanvasPath);
    const leaf = view ? this.findLeafForView(view) : null;
    if (!view || !leaf || !(await this.isAmoManagedCanvasView(view))) return false;

    try {
      await leaf.openFile(file as any, { active: true });
      this.debugLog("canvas.explicit_refresh.ok", {
        canvasPath: normalizedCanvasPath,
      });
      return true;
    } catch (error) {
      this.debugLog("canvas.explicit_refresh.error", {
        canvasPath: normalizedCanvasPath,
        message: messageFromError(error),
      });
      return false;
    }
  }

  getCanvasViewForFilePath(canvasPath) {
    const normalizedCanvasPath = normalizeVaultFilePath(canvasPath);
    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      const view: any = leaf.view;
      if (view && view.file && normalizeVaultFilePath(view.file.path) === normalizedCanvasPath) {
        return view;
      }
    }
    return null;
  }

  async isAmoManagedCanvasView(view) {
    const file = view && view.file;
    if (!file) return false;

    try {
      const raw = await this.app.vault.read(file);
      const parsed = JSON.parse(raw);
      const amo = parsed && typeof parsed === "object" ? parsed.amo : null;
      const managedCanvas =
        Boolean(amo) && amo.managedBy === AMO_CANVAS_MANAGER && amo.canvasType === AMO_CANVAS_TYPE;
      if (view.containerEl) {
        view.containerEl.classList.toggle("amo-managed-canvas", managedCanvas);
      }
      this.debugLog("canvas.amo_marker.checked", {
        canvasPath: file.path,
        managedCanvas,
      });
      return managedCanvas;
    } catch (error) {
      if (view.containerEl) {
        view.containerEl.classList.remove("amo-managed-canvas");
      }
      this.debugLog("canvas.amo_marker.error", {
        canvasPath: file.path,
        message: messageFromError(error),
      });
      return false;
    }
  }

  async syncAmoCanvasRendering() {
    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      const view: any = leaf.view;
      if (!view) continue;
      const managedCanvas = await this.isAmoManagedCanvasView(view);
      if (!managedCanvas) {
        this.clearAmoCanvasRendering(view);
      }
    }
  }

  clearAmoCanvasRendering(view) {
    if (!view || !view.containerEl) return;
    view.containerEl.classList.remove("amo-managed-canvas");
  }

  findCanvasNodeForFilePath(view, notePath) {
    const normalizedNotePath = normalizeVaultFilePath(notePath);
    return (
      collectCanvasNodes(view && view.canvas).find((node) => {
        return normalizeVaultFilePath(canvasNodeFilePath(view.canvas, node)) === normalizedNotePath;
      }) || null
    );
  }

  selectCanvasNode(view, node, notePath) {
    const canvas = view && view.canvas;
    const marked = this.markCanvasLatestNote(view, node);

    this.safeCanvasCall(canvas, "requestFrame");
    this.debugLog("canvas.focus_note.selected", {
      canvasPath: view && view.file && view.file.path,
      notePath,
      nodeId: node && (node.id || (node.data && node.data.id)),
      marked,
    });
  }

  markCanvasLatestNote(view, node) {
    this.clearCanvasLatestNoteMarkers(view);
    const element = this.canvasNodeElement(view, node);
    if (!element) return false;
    element.classList.add("amo-canvas-latest-note");
    element.setAttribute("data-amo-latest-note", "true");
    return true;
  }

  clearCanvasLatestNoteMarkers(view) {
    if (!view || !view.containerEl) return;
    const markedElements = Array.from(view.containerEl.querySelectorAll(".amo-canvas-latest-note")) as HTMLElement[];
    for (const element of markedElements) {
      element.classList.remove("amo-canvas-latest-note");
      element.removeAttribute("data-amo-latest-note");
    }
  }

  clearCanvasSelectionArtifact(view, node) {
    const canvas = view && view.canvas;
    const nodeId = node && (node.id || (node.data && node.data.id));
    let cleaned = false;

    if (node) {
      if (node.selected || node.isSelected) cleaned = true;
      node.selected = false;
      node.isSelected = false;
    }

    for (const collection of [canvas && canvas.selection, canvas && canvas.selectedNodes, canvas && canvas.selectedItems, canvas && canvas.selected]) {
      if (this.removeCanvasSelectionValue(collection, node, nodeId)) {
        cleaned = true;
      }
    }

    const element = this.canvasNodeElement(view, node);
    if (element) {
      for (const className of ["is-selected", "mod-selected", "selected"]) {
        if (element.classList.contains(className)) cleaned = true;
        element.classList.remove(className);
      }
    }

    return cleaned;
  }

  clearCanvasSelection(canvas) {
    this.safeCanvasCall(canvas, "deselectAll");
    this.safeCanvasCall(canvas, "clearSelection");
    for (const collection of [canvas && canvas.selection, canvas && canvas.selectedNodes, canvas && canvas.selectedItems, canvas && canvas.selected]) {
      if (collection && typeof collection.clear === "function") {
        this.safeCanvasCall(collection, "clear");
      }
    }

    for (const node of collectCanvasNodes(canvas)) {
      if (!node) continue;
      node.selected = false;
      node.isSelected = false;
    }
  }

  removeCanvasSelectionValue(collection, node, nodeId) {
    if (!collection) return false;
    let removed = false;

    if (Array.isArray(collection)) {
      for (const value of [node, nodeId]) {
        const index = value ? collection.indexOf(value) : -1;
        if (index >= 0) {
          collection.splice(index, 1);
          removed = true;
        }
      }
    }

    if (typeof collection.delete === "function") {
      if (node && collection.delete(node)) removed = true;
      if (nodeId && collection.delete(nodeId)) removed = true;
    }

    if (typeof collection.has === "function" && typeof collection.remove === "function") {
      if (node && collection.has(node)) {
        this.safeCanvasCall(collection, "remove", node);
        removed = true;
      }
      if (nodeId && collection.has(nodeId)) {
        this.safeCanvasCall(collection, "remove", nodeId);
        removed = true;
      }
    }

    return removed;
  }

  addCanvasSelectionValue(collection, node) {
    if (!collection || !node) return;
    if (typeof collection.add === "function") {
      this.safeCanvasCall(collection, "add", node);
      return;
    }
    if (typeof collection.set === "function") {
      const nodeId = node.id || (node.data && node.data.id);
      this.safeCanvasCall(collection, "set", nodeId || node, node);
    }
  }

  centerCanvasNode(view, node) {
    const canvas = view && view.canvas;
    const bounds = this.canvasNodeBounds(node);
    if (!bounds) return false;

    const bbox = {
      minX: bounds.x,
      minY: bounds.y,
      maxX: bounds.x + bounds.width,
      maxY: bounds.y + bounds.height,
    };

    if (this.safeCanvasCall(canvas, "zoomToBbox", bbox)) return true;
    if (this.safeCanvasCall(canvas, "zoomToBBox", bbox)) return true;

    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    if (this.safeCanvasCall(canvas, "panTo", centerX, centerY)) return true;
    if (this.safeCanvasCall(canvas, "setViewport", centerX, centerY, this.canvasZoom(canvas))) return true;

    const element = this.canvasNodeElement(view, node);
    if (element && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
      return true;
    }

    return false;
  }

  canvasNodeBounds(node) {
    const data = node && typeof node.getData === "function" ? node.getData() : node && node.data;
    const x = this.numberValue(node && node.x, data && data.x);
    const y = this.numberValue(node && node.y, data && data.y);
    const width = this.numberValue(node && node.width, node && node.w, data && data.width, data && data.w, 520);
    const height = this.numberValue(node && node.height, node && node.h, data && data.height, data && data.h, 360);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, width, height };
  }

  numberValue(...values) {
    for (const value of values) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
    return 0;
  }

  canvasZoom(canvas) {
    return this.numberValue(canvas && canvas.zoom, canvas && canvas.scale, canvas && canvas.tZoom, 1) || 1;
  }

  canvasNodeElement(view, node) {
    for (const candidate of [node && node.nodeEl, node && node.el, node && node.containerEl, node && node.contentEl]) {
      if (candidate instanceof HTMLElement) return candidate;
    }

    const nodeId = node && (node.id || (node.data && node.data.id));
    if (!nodeId || !view || !view.containerEl) return null;
    const escaped = String(nodeId).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return (
      view.containerEl.querySelector('[data-node-id="' + escaped + '"]') ||
      view.containerEl.querySelector('[data-id="' + escaped + '"]') ||
      view.containerEl.querySelector("#" + String(nodeId).replace(/[^a-zA-Z0-9_-]/g, "\\$&"))
    );
  }

  safeCanvasCall(target, method, ...args) {
    try {
      if (target && typeof target[method] === "function") {
        target[method](...args);
        return true;
      }
    } catch (error) {
      this.debugLog("canvas.focus_note.call_error", {
        method,
        message: messageFromError(error),
      });
    }
    return false;
  }

  delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  createTabLeaf() {
    try {
      return this.app.workspace.getLeaf("tab");
    } catch {
      return this.app.workspace.getLeaf(true);
    }
  }

  findLeafForFilePath(filePath, kind) {
    const primaryTypes = kind === "canvas" ? ["canvas"] : ["markdown"];
    for (const viewType of primaryTypes) {
      const leaf = this.findLeafForFilePathInViewType(filePath, viewType);
      if (leaf) return leaf;
    }

    for (const viewType of ["markdown", "canvas"]) {
      if (primaryTypes.includes(viewType)) continue;
      const leaf = this.findLeafForFilePathInViewType(filePath, viewType);
      if (leaf) return leaf;
    }

    return null;
  }

  findLeafForFilePathInViewType(filePath, viewType) {
    for (const leaf of this.app.workspace.getLeavesOfType(viewType)) {
      const view: any = leaf.view;
      if (view && view.file && view.file.path === filePath) {
        return leaf;
      }
    }
    return null;
  }

  syncMarkdownViewActions() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (!(leaf.view instanceof MarkdownView)) continue;
      const view = leaf.view;
      this.rememberMarkdownView(view, leaf);

      if (!view.containerEl.querySelector("." + AMO_SEND_ACTION_CLASS)) {
        const sendAction = view.addAction("send", "Send annotations to AMO", () => {
          if (!view.file) {
            new Notice("No active Markdown note.");
            return;
          }
          void this.sendAnnotationsFromFile(view.file);
        });
        sendAction.addClass(AMO_SEND_ACTION_CLASS);
      }

      if (!view.containerEl.querySelector("." + AMO_PANEL_ACTION_CLASS)) {
        const panelAction = view.addAction("panel-right", "Open AMO panel", () => {
          void this.activatePanel();
        });
        panelAction.addClass(AMO_PANEL_ACTION_CLASS);
      }
    }
  }

  syncCanvasViewActions() {
    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      const view: any = leaf.view;
      if (!view || !view.containerEl || typeof view.addAction !== "function") continue;
      this.ensureCanvasTargetTracking(view);

      if (!view.containerEl.querySelector("." + AMO_CANVAS_SEND_ACTION_CLASS)) {
        const sendAction = view.addAction("send", "Send selected note annotations to AMO", () => {
          void this.sendAnnotationsFromCanvas(view);
        });
        sendAction.addClass(AMO_CANVAS_SEND_ACTION_CLASS);
        this.debugLog("canvas.action.added", {
          action: "send",
          canvasPath: view.file && view.file.path,
        });
      }

      if (!view.containerEl.querySelector("." + AMO_CANVAS_PANEL_ACTION_CLASS)) {
        const panelAction = view.addAction("panel-right", "Open AMO panel", () => {
          void this.openPanelFromCanvas(view);
        });
        panelAction.addClass(AMO_CANVAS_PANEL_ACTION_CLASS);
        this.debugLog("canvas.action.added", {
          action: "panel",
          canvasPath: view.file && view.file.path,
        });
      }
    }
  }

  async sendAnnotationsFromCanvas(view) {
    const rememberedBefore = this.getRememberedCanvasMarkdownFileTarget(view);
    const selectedCount = collectCanvasSelectedNodes(view && view.canvas).length;
    const file = this.getCanvasMarkdownFileForAction(view);
    this.debugLog("canvas.send.clicked", {
      canvasPath: view && view.file && view.file.path,
      targetPath: file && file.path,
      targetSource: file ? this.lastMarkdownTargetSource : null,
      rememberedPathBefore: rememberedBefore && rememberedBefore.file && rememberedBefore.file.path,
      selectedCount,
    });
    if (file) {
      await this.sendAnnotationsFromFile(file);
      return;
    }

    this.debugLog("canvas.send.choose_target", {
      canvasPath: view && view.file && view.file.path,
    });
    await this.chooseCanvasMarkdownFile(view, "Send", async (selectedFile) => {
      await this.sendAnnotationsFromFile(selectedFile);
    });
  }

  async openPanelFromCanvas(view) {
    const rememberedBefore = this.getRememberedCanvasMarkdownFileTarget(view);
    const selectedCount = collectCanvasSelectedNodes(view && view.canvas).length;
    const file = this.getCanvasMarkdownFileForAction(view);
    this.debugLog("canvas.panel.clicked", {
      canvasPath: view && view.file && view.file.path,
      targetPath: file && file.path,
      targetSource: file ? this.lastMarkdownTargetSource : null,
      rememberedPathBefore: rememberedBefore && rememberedBefore.file && rememberedBefore.file.path,
      selectedCount,
    });
    if (file) {
      this.rememberCanvasMarkdownFile(view, file.path);
      await this.activatePanel();
      return;
    }

    await this.chooseCanvasMarkdownFile(view, "Use", async (selectedFile) => {
      this.rememberCanvasMarkdownFile(view, selectedFile.path);
      await this.activatePanel();
    });
  }

  ensureCanvasTargetTracking(view) {
    if (this.canvasViewsWithTargetTracking.has(view)) return;
    this.canvasViewsWithTargetTracking.add(view);

    this.registerDomEvent(view.containerEl, "pointerdown", (event) => {
      this.rememberCanvasTargetFromEvent(view, event);
    });
  }

  rememberCanvasTargetFromEvent(view, event) {
    const target = event && event.target;
    const element = target instanceof Element ? target : null;
    if (element && element.closest(".view-action, .clickable-icon, button")) {
      this.debugLog("canvas.pointer.ignored_action", {
        canvasPath: view && view.file && view.file.path,
        target: describeElement(element),
      });
      return;
    }

    this.canvasTargetFilePathByView.delete(view);

    const filePath = canvasFilePathFromEventTarget(view.canvas, target);
    if (filePath && filePath.toLowerCase().endsWith(".md")) {
      const file = this.app.vault.getAbstractFileByPath(normalizeVaultFilePath(filePath));
      if (file && typeof file.path === "string") {
        this.rememberCanvasMarkdownFile(view, file.path);
        this.debugLog("canvas.pointer.remembered", {
          canvasPath: view && view.file && view.file.path,
          notePath: file.path,
          target: element ? describeElement(element) : null,
        });
      }
      return;
    }

    this.debugLog("canvas.pointer.cleared", {
      canvasPath: view && view.file && view.file.path,
      target: element ? describeElement(element) : null,
    });
  }

  setOperationStatus(message, tone = "neutral") {
    this.operationStatus = {
      tone: tone || "neutral",
      message,
      at: new Date().toISOString(),
    };
    this.refreshPanels();
  }

  rememberCurrentMarkdownView() {
    this.rememberMarkdownLeaf(this.app.workspace.activeLeaf);

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) {
      this.rememberMarkdownView(view, this.findLeafForView(view));
    }
  }

  rememberMarkdownLeaf(leaf) {
    if (!leaf || !(leaf.view instanceof MarkdownView)) return;
    this.rememberMarkdownView(leaf.view, leaf);
  }

  rememberMarkdownView(view, leaf = null) {
    if (!view || !(view instanceof MarkdownView) || !view.file) return;
    this.lastMarkdownView = view;
    this.lastMarkdownLeaf = leaf || this.findLeafForView(view);
    this.lastMarkdownFilePath = view.file.path;
    this.lastMarkdownTargetSource = "last-note";
  }

  findLeafForView(view) {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view === view) return leaf;
    }
    return null;
  }

  findMarkdownLeafForFilePath(filePath) {
    if (!filePath) return null;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.file && leaf.view.file.path === filePath) {
        return leaf;
      }
    }
    return null;
  }

  getActiveMarkdownView() {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file) {
      this.rememberMarkdownView(activeView, this.findLeafForView(activeView));
      return activeView;
    }

    if (this.lastMarkdownView && this.lastMarkdownView.file) {
      return this.lastMarkdownView;
    }

    const rememberedLeaf = this.findMarkdownLeafForFilePath(this.lastMarkdownFilePath);
    if (rememberedLeaf && rememberedLeaf.view instanceof MarkdownView) {
      this.rememberMarkdownLeaf(rememberedLeaf);
      return rememberedLeaf.view;
    }

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.file) {
        this.rememberMarkdownLeaf(leaf);
        return leaf.view;
      }
    }

    return null;
  }

  getActiveMarkdownFile() {
    const target = this.getActiveMarkdownFileTarget();
    return target ? target.file : null;
  }

  getActiveMarkdownFileTarget() {
    const shouldPreferCanvasTarget =
      this.isActiveLeafCanvas() ||
      this.isActiveLeafAmoPanel() ||
      this.lastMarkdownTargetSource === "canvas-selection";
    if (shouldPreferCanvasTarget) {
      const canvasView = this.getActiveCanvasView() || this.lastCanvasView;
      const selectedCanvasTarget = this.getSelectedCanvasMarkdownFileTarget(canvasView, {
        allowRemembered: false,
        refreshPanels: false,
      });
      if (selectedCanvasTarget) return selectedCanvasTarget;

      const rememberedCanvasTarget = canvasView ? this.getRememberedCanvasMarkdownFileTarget(canvasView) : null;
      if (rememberedCanvasTarget) return rememberedCanvasTarget;

      if (this.isActiveLeafCanvas()) {
        return null;
      }
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file) {
      this.rememberMarkdownView(activeView, this.findLeafForView(activeView));
      return {
        file: activeView.file,
        source: "active-note",
      };
    }

    const selectedCanvasTarget = this.getSelectedCanvasMarkdownFileTarget();
    if (selectedCanvasTarget) return selectedCanvasTarget;

    if (this.isActiveLeafCanvas()) {
      return null;
    }

    if (this.lastMarkdownTargetSource === "canvas-selection") {
      const rememberedCanvasTarget = this.getRememberedMarkdownFileTarget();
      if (rememberedCanvasTarget) return rememberedCanvasTarget;
    }

    const view = this.getActiveMarkdownView();
    if (view && view.file) {
      return {
        file: view.file,
        source: this.lastMarkdownTargetSource || "last-note",
      };
    }

    const rememberedTarget = this.getRememberedMarkdownFileTarget();
    if (rememberedTarget) return rememberedTarget;

    return null;
  }

  getRememberedMarkdownFileTarget() {
    if (!this.lastMarkdownFilePath) return null;
    const file = this.app.vault.getAbstractFileByPath(this.lastMarkdownFilePath);
    if (!file || typeof file.path !== "string") return null;
    return {
      file,
      source: this.lastMarkdownTargetSource || "last-note",
    };
  }

  getSelectedCanvasMarkdownFile(view) {
    const target = this.getSelectedCanvasMarkdownFileTarget(view);
    return target ? target.file : null;
  }

  getCanvasMarkdownFileForAction(view) {
    const target =
      this.getSelectedCanvasMarkdownFileTarget(view, { allowRemembered: false }) ||
      this.getRememberedCanvasMarkdownFileTarget(view);
    return target ? target.file : null;
  }

  getSelectedCanvasMarkdownFileTarget(view = null, options = null) {
    const canvasView = view || this.getActiveCanvasView();
    if (!canvasView) return null;

    const allowRemembered = !options || options.allowRemembered !== false;
    if (allowRemembered) {
      const rememberedCanvasTarget = this.getRememberedCanvasMarkdownFileTarget(canvasView);
      if (rememberedCanvasTarget) return rememberedCanvasTarget;
    }

    const selectedNodes = collectCanvasSelectedNodes(canvasView.canvas);
    for (const node of selectedNodes) {
      const filePath = canvasNodeFilePath(canvasView.canvas, node);
      if (!filePath || !filePath.toLowerCase().endsWith(".md")) continue;
      const file = this.app.vault.getAbstractFileByPath(normalizeVaultFilePath(filePath));
      if (file && typeof file.path === "string") {
        const changed = this.rememberCanvasMarkdownFile(canvasView, file.path, {
          refreshPanels: options ? options.refreshPanels : undefined,
        });
        if (changed) {
          this.debugLog("canvas.selection.remembered", {
            canvasPath: canvasView.file && canvasView.file.path,
            notePath: file.path,
            selectedCount: selectedNodes.length,
          });
        }
        return {
          file,
          source: "canvas-selection",
        };
      }
    }

    return null;
  }

  rememberCanvasMarkdownFile(view, filePath, options = null) {
    const previousPath = this.canvasTargetFilePathByView.get(view);
    const changed =
      previousPath !== filePath ||
      this.lastMarkdownFilePath !== filePath ||
      this.lastMarkdownTargetSource !== "canvas-selection";

    this.lastCanvasView = view;
    this.canvasTargetFilePathByView.set(view, filePath);
    this.lastMarkdownView = null;
    this.lastMarkdownLeaf = null;
    this.lastMarkdownFilePath = filePath;
    this.lastMarkdownTargetSource = "canvas-selection";
    if (changed && (!options || options.refreshPanels !== false)) {
      this.schedulePanelRefresh("canvas-target-changed");
    }
    return changed;
  }

  getRememberedCanvasMarkdownFileTarget(view) {
    const filePath = this.canvasTargetFilePathByView.get(view);
    if (!filePath) return null;
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || typeof file.path !== "string") return null;
    return {
      file,
      source: "canvas-selection",
    };
  }

  rememberSelectedCanvasMarkdownFile(view) {
    return this.getSelectedCanvasMarkdownFileTarget(view);
  }

  async chooseCanvasMarkdownFile(view, actionLabel, onSelect) {
    const targets = await this.listCanvasMarkdownFileTargets(view);
    this.debugLog("canvas.target_modal.open", {
      actionLabel,
      canvasPath: view && view.file && view.file.path,
      targetCount: targets.length,
      targets: targets.slice(0, 12).map((target) => target.file.path),
    });
    if (targets.length === 0) {
      new Notice("No Markdown note nodes found on this canvas.");
      return;
    }

    new CanvasNoteTargetModal(this.app, targets, actionLabel, async (target) => {
      this.rememberCanvasMarkdownFile(view, target.file.path);
      this.debugLog("canvas.target_modal.selected", {
        actionLabel,
        canvasPath: view && view.file && view.file.path,
        notePath: target.file.path,
      });
      await onSelect(target.file);
    }).open();
  }

  async listCanvasMarkdownFileTargets(view) {
    const targets = [];
    const seen = new Set();

    for (const node of collectCanvasNodes(view && view.canvas)) {
      const filePath = canvasNodeFilePath(view.canvas, node);
      this.addCanvasFileTarget(targets, seen, filePath, node.x || (node.data && node.data.x), node.y || (node.data && node.data.y));
    }

    if (view && view.file) {
      try {
        const raw = await this.app.vault.cachedRead(view.file as any);
        const canvas = JSON.parse(raw);
        for (const node of Array.isArray(canvas.nodes) ? canvas.nodes : []) {
          this.addCanvasFileTarget(targets, seen, node.file, node.x, node.y);
        }
      } catch {
        // Ignore malformed or unavailable canvas file data; live canvas nodes above may still be enough.
      }
    }

    const sorted = targets.sort((a, b) => {
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    });
    this.debugLog("canvas.targets.listed", {
      canvasPath: view && view.file && view.file.path,
      count: sorted.length,
      targets: sorted.slice(0, 12).map((target) => target.file.path),
    });
    return sorted;
  }

  addCanvasFileTarget(targets, seen, filePath, x, y) {
    const normalizedPath = normalizeVaultFilePath(filePath);
    if (!normalizedPath || !normalizedPath.toLowerCase().endsWith(".md") || seen.has(normalizedPath)) return;

    const file = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!file || typeof file.path !== "string") return;

    seen.add(normalizedPath);
    targets.push({
      file,
      x: Number.isFinite(Number(x)) ? Number(x) : 0,
      y: Number.isFinite(Number(y)) ? Number(y) : 0,
    });
  }

  getActiveCanvasView() {
    const leaf = this.app.workspace.activeLeaf;
    if (!leaf || !leaf.view || typeof leaf.view.getViewType !== "function") return null;
    return leaf.view.getViewType() === "canvas" ? leaf.view : null;
  }

  isActiveLeafCanvas() {
    return Boolean(this.getActiveCanvasView());
  }

  isActiveLeafAmoPanel() {
    const leaf = this.app.workspace.activeLeaf;
    if (!leaf || !leaf.view || typeof leaf.view.getViewType !== "function") return false;
    return leaf.view.getViewType() === AMO_PANEL_VIEW_TYPE;
  }

  activeLeafType() {
    const leaf = this.app.workspace.activeLeaf;
    if (!leaf || !leaf.view || typeof leaf.view.getViewType !== "function") return "none";
    return leaf.view.getViewType();
  }

  canInsertAnnotationAtActiveEditor() {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.editor) return true;
    return Boolean(!this.isActiveLeafCanvas() && this.lastMarkdownView && this.lastMarkdownView.editor);
  }

  insertAnnotationAtActiveEditor() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView) || this.getActiveMarkdownView();
    if (!view || !view.editor) {
      new Notice("No active Markdown editor.");
      return;
    }

    const leaf = this.findLeafForView(view) || this.lastMarkdownLeaf;
    if (leaf) {
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    }
    this.wrapSelectionWithAnnotation(view.editor);
    this.setOperationStatus("Inserted annotation marker.", "success");
  }

  async insertAnnotationFromCurrentSelection() {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.editor) {
      this.wrapSelectionWithAnnotation(activeView.editor);
      this.setOperationStatus("Inserted annotation marker.", "success");
      return;
    }

    const selectedText = getWindowSelectionText();
    const file = this.getActiveMarkdownFile();
    if (selectedText && file) {
      await this.appendReferencedAnnotationToFile(file, selectedText);
      return;
    }

    this.insertAnnotationAtActiveEditor();
  }

  wrapSelectionWithAnnotation(editor) {
    const selection = editor.getSelection();
    if (selection.trim().length > 0) {
      insertReferencedAnnotation(editor, selection);
      return;
    }

    const cursor = editor.getCursor();
    editor.replaceSelection(ANNO_TAG_PREFIX + ANNO_TAG_SUFFIX);
    editor.setCursor({
      line: cursor.line,
      ch: cursor.ch + ANNO_TAG_PREFIX.length,
    });
  }

  async appendReferencedAnnotationToFile(file, reference) {
    const content = normalizeAnnotationContent(reference);
    if (!content) {
      new Notice("No selected text to quote.");
      return;
    }

    await this.appendAnnotationBlockToFile(file, buildReferencedAnnotationMarkup(content));
    this.setOperationStatus("Referenced annotation appended to " + file.path + ".", "success");
    new Notice("Referenced annotation appended.");
  }

  async appendAnnotationToFile(file, rawContent) {
    const content = normalizeAnnotationContent(rawContent);
    if (!content) {
      new Notice("Annotation content cannot be empty.");
      return;
    }

    if (content.includes(ANNO_TAG_SUFFIX)) {
      new Notice("Annotation content cannot include " + ANNO_TAG_SUFFIX + ".");
      return;
    }

    const block = buildAnnotationMarkup(content);
    await this.appendAnnotationBlockToFile(file, block);
    this.setOperationStatus("Annotation appended to " + file.path + ".", "success");
    new Notice("Annotation appended.");
  }

  async appendAnnotationBlockToFile(file, block) {
    const markdown = await this.app.vault.cachedRead(file as any);
    const nextContent = markdown.trim().length === 0
      ? block + "\n"
      : markdown.replace(/\s*$/u, "") + "\n\n" + block + "\n";

    await this.app.vault.modify(file, nextContent);
  }

  async copyAnnotationsFromActiveFile() {
    const target = this.getActiveMarkdownFileTarget();
    const file = target ? target.file : null;
    this.debugLog("annotations.copy.resolve", {
      notePath: file && file.path,
      source: target && target.source,
      activeLeafType: this.activeLeafType(),
    });
    if (!file) {
      new Notice("No active Markdown note.");
      return;
    }

    await this.copyAnnotationsFromFile(file);
  }

  async copyAnnotationsFromFile(file) {
    const markdown = await this.app.vault.cachedRead(file as any);
    const annotations = extractAnnotationContents(markdown);
    this.debugLog("annotations.copy.extract", {
      notePath: file.path,
      annotationCount: annotations.length,
      annotationPreviews: annotations.slice(0, 5).map((annotation) => previewText(annotation)),
      activeLeafType: this.activeLeafType(),
    });
    if (annotations.length === 0) {
      new Notice("No annotations found in the current note.");
      return;
    }

    try {
      await writeTextToClipboard(formatAnnotationsForClipboard(annotations));
      this.debugLog("annotations.copy.ok", {
        notePath: file.path,
        annotationCount: annotations.length,
      });
      this.setOperationStatus("Copied " + annotations.length + " annotation(s) from " + file.path + ".", "success");
      new Notice("Copied " + annotations.length + " annotation(s).");
    } catch (error) {
      console.error("Failed to copy annotations:", error);
      this.debugLog("annotations.copy.error", {
        notePath: file.path,
        message: messageFromError(error),
      });
      this.setOperationStatus("Copy failed: " + messageFromError(error), "error");
      new Notice("Copy failed: " + messageFromError(error));
    }
  }

  async sendAnnotationsFromActiveFile() {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      new Notice("No active Markdown note.");
      return;
    }

    await this.sendAnnotationsFromFile(file);
  }

  async sendAnnotationsFromFile(file) {
    const sendStartedAtMs = Date.now();
    this.debugLog("annotations.send.prepare_start", {
      notePath: file.path,
      startedAtMs: sendStartedAtMs,
    });
    const readStartedAtMs = Date.now();
    const markdown = await this.app.vault.cachedRead(file as any);
    const readDurationMs = Date.now() - readStartedAtMs;
    const extractStartedAtMs = Date.now();
    const annotations = extractAnnotationContents(markdown);
    const extractDurationMs = Date.now() - extractStartedAtMs;
    this.debugLog("annotations.extract", {
      notePath: file.path,
      annotationCount: annotations.length,
      annotationPreviews: annotations.slice(0, 5).map((annotation) => previewText(annotation)),
      markdownHasAnnoOpen: markdown.includes(ANNO_TAG_PREFIX),
      markdownHasAnnoClose: markdown.includes(ANNO_TAG_SUFFIX),
      readDurationMs,
      extractDurationMs,
      elapsedMs: Date.now() - sendStartedAtMs,
    });
    if (annotations.length === 0) {
      new Notice("No annotations found in the current note.");
      return;
    }

    const amo = parseAmoFrontmatter(markdown);
    this.debugLog("annotations.frontmatter", {
      notePath: file.path,
      sessionId: amo.sessionId || null,
      turnId: amo.turnId || null,
    });
    if (!amo.sessionId) {
      new Notice("This note is missing AMO session metadata.");
      return;
    }

    const payload = {
      schemaVersion: 1,
      source: "obsidian-md-anno-tools",
      vaultRoot: getVaultRoot(this.app),
      notePath: file.path,
      sessionId: amo.sessionId,
      turnId: amo.turnId || null,
      promptOptions: {
        numberAnnotations: Boolean(this.settings.numberAnnotationsInPrompt),
      },
      annotations: annotations.map((content, index) => ({
        index: index + 1,
        content,
      })),
    };

    try {
      const postStartedAtMs = Date.now();
      this.debugLog("annotations.send.start", {
        notePath: file.path,
        sessionId: payload.sessionId,
        turnId: payload.turnId,
        annotationCount: payload.annotations.length,
        elapsedMs: postStartedAtMs - sendStartedAtMs,
      });
      const result = await postJson(joinUrl(this.settings.bridgeUrl, "/api/obsidian/annotations"), payload);
      this.debugLog("annotations.send.ok", {
        notePath: file.path,
        sessionId: payload.sessionId,
        pendingPromptId: result.pendingPromptId || null,
        annotationCount: payload.annotations.length,
        postDurationMs: Date.now() - postStartedAtMs,
        totalDurationMs: Date.now() - sendStartedAtMs,
      });
      this.setOperationStatus(
        "Sent " + annotations.length + " annotation(s) from " + file.path + " to AMO.",
        "success"
      );
      new Notice(
        "Sent " +
          annotations.length +
          " annotation(s) to AMO" +
          (result.pendingPromptId ? ": " + result.pendingPromptId : ".")
      );
    } catch (error) {
      console.error("Failed to send annotations to AMO:", error);
      this.debugLog("annotations.send.error", {
        notePath: file.path,
        sessionId: payload.sessionId,
        message: messageFromError(error),
      });
      this.setOperationStatus("AMO sync failed: " + messageFromError(error), "error");
      new Notice("AMO sync failed: " + messageFromError(error));
    }
  }

  async checkBridgeHealth() {
    try {
      const result = await fetchJson(joinUrl(this.settings.bridgeUrl, "/api/health"));
      this.setOperationStatus(
        "Bridge online: " + (result.service || "AMO") + " on port " + (result.port || "unknown") + ".",
        "success"
      );
      new Notice("AMO bridge is online.");
    } catch (error) {
      this.setOperationStatus("Bridge check failed: " + messageFromError(error), "error");
      new Notice("AMO bridge check failed: " + messageFromError(error));
    }
  }

  async getActiveNoteInfo() {
    const target = this.getActiveMarkdownFileTarget();
    if (!target || !target.file) {
      return {
        file: null,
        source: this.isActiveLeafCanvas() ? "canvas-selection-missing" : "none",
        annotations: [],
        amo: {},
      };
    }

    const file = target.file;
    const markdown = await this.app.vault.cachedRead(file as any);
    return {
      file,
      source: target.source,
      annotations: extractAnnotationContents(markdown),
      amo: parseAmoFrontmatter(markdown),
    };
  }

  async renderAnnotations(root, context) {
    if (await this.renderLegacyAnnotationSection(root, context)) return;

    if (rootContainsAnnotationMarkers(root)) {
      this.debugLog("render.postprocessor", {
        root: describeElement(root),
        preview: previewText(root.textContent || ""),
      });
    }

    this.replaceInlineAnnotations(root);
  }

  async renderLegacyAnnotationSection(root, context) {
    if (!(root instanceof HTMLElement) || !context || typeof context.getSectionInfo !== "function") return false;

    const section = context.getSectionInfo(root);
    if (!section || typeof section.text !== "string") return false;

    const block = await this.findLegacyAnnotationBlockForSection(context.sourcePath, section);
    if (!block) return false;
    if (!root.isConnected) return true;

    if (block.role === "start") {
      this.debugLog("render.legacy_section", {
        role: "start",
        sourcePath: context.sourcePath,
        lineStart: section.lineStart,
        lineEnd: section.lineEnd,
        annotationStart: block.startLine,
        annotationEnd: block.endLine,
        ownerLine: block.ownerLine,
        preview: previewText(block.content),
      });
      context.addChild(new LegacyAnnotationBlockRenderChild(root, this, block.content, context.sourcePath));
      return true;
    }

    this.debugLog("render.legacy_section", {
      role: "hidden",
      sourcePath: context.sourcePath,
      lineStart: section.lineStart,
      lineEnd: section.lineEnd,
      annotationStart: block.startLine,
      annotationEnd: block.endLine,
      ownerLine: block.ownerLine,
    });
    context.addChild(new LegacyAnnotationHiddenSectionRenderChild(root));
    return true;
  }

  async findLegacyAnnotationBlockForSection(sourcePath, section) {
    const file = sourcePath ? this.app.vault.getAbstractFileByPath(normalizeVaultFilePath(sourcePath)) : null;
    if (!file || typeof file.path !== "string") return null;

    let markdown = "";
    try {
      markdown = await this.app.vault.cachedRead(file as any);
    } catch {
      return null;
    }

    return findLegacyAnnotationBlockForSection(parseLegacyAnnotationBlocks(markdown), section);
  }

  replaceInlineAnnotations(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!(node instanceof Text)) return NodeFilter.FILTER_REJECT;
        if (!this.shouldProcessTextNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);
    for (const textNode of targets) this.replaceAnnotationsInTextNode(textNode);
  }

  shouldProcessTextNode(textNode) {
    const text = textNode.nodeValue || "";
    if (!text.includes(ANNO_TAG_PREFIX) || !text.includes(ANNO_TAG_SUFFIX)) return false;
    const parent = textNode.parentElement;
    if (!parent || parent.closest(".anno-token")) return false;

    for (let current = parent; current; current = current.parentElement) {
      if (SKIPPED_TAGS.has(current.tagName)) return false;
    }
    return true;
  }

  replaceAnnotationsInTextNode(textNode) {
    const source = textNode.nodeValue || "";
    const matches = Array.from(source.matchAll(ANNO_REGEX)) as RegExpMatchArray[];
    if (matches.length === 0) return;

    const fragment = document.createDocumentFragment();
    let currentIndex = 0;
    const firstMatch = matches[0];
    const isStandalone = matches.length === 1 && firstMatch && source.trim() === firstMatch[0].trim();

    for (const match of matches) {
      const fullMatch = match[0];
      const content = normalizeAnnotationContent(match[1] || "");
      const matchIndex = match.index || 0;

      if (matchIndex > currentIndex) fragment.append(source.slice(currentIndex, matchIndex));
      fragment.append(createAnnotationElement(content, isStandalone));
      currentIndex = matchIndex + fullMatch.length;
    }

    if (currentIndex < source.length) fragment.append(source.slice(currentIndex));
    textNode.replaceWith(fragment);
  }
}


export default AmoMarkdownAnnotationToolsPlugin;
