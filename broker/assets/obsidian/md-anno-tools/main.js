const {
  ButtonComponent,
  ItemView,
  MarkdownRenderChild,
  MarkdownRenderer,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  TextAreaComponent,
} = require("obsidian");

const ANNO_REGEX = /\[!anno\]([\s\S]*?)\[\/anno\]/gi;
const ANNO_TAG_PREFIX = "[!anno]";
const ANNO_TAG_SUFFIX = "[/anno]";
const EMPTY_ANNO_TEXT = "(empty annotation)";
const ANNOTATION_DEFAULT_LABEL = "批注";
const PLUGIN_VERSION = "1.4.5";
const DEFAULT_SETTINGS = {
  bridgeUrl: "http://127.0.0.1:17654",
};
const AMO_PANEL_VIEW_TYPE = "amo-annotation-panel";
const AMO_OPEN_PROTOCOL = "amo-open";
const AMO_SEND_ACTION_CLASS = "amo-send-note-action";
const AMO_PANEL_ACTION_CLASS = "amo-open-panel-action";
const AMO_CANVAS_SEND_ACTION_CLASS = "amo-send-canvas-note-action";
const AMO_CANVAS_PANEL_ACTION_CLASS = "amo-open-canvas-panel-action";
const DEFAULT_CANVAS_PATH = "AgentFlow.canvas";
const SKIPPED_TAGS = new Set(["A", "BUTTON", "CODE", "INPUT", "PRE", "SCRIPT", "STYLE", "TEXTAREA"]);

class AmoMarkdownAnnotationToolsPlugin extends Plugin {
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
      this.refreshPanels();
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.rememberMarkdownLeaf(leaf);
        this.syncMarkdownViewActions();
        this.syncCanvasViewActions();
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
        this.refreshPanels();
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.rememberCurrentMarkdownView();
        this.syncMarkdownViewActions();
        this.syncCanvasViewActions();
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
      if (leaf.view && typeof leaf.view.render === "function") {
        leaf.view.render();
      }
    }
  }

  schedulePanelRefresh(reason) {
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

  debugLog(event, data) {
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

    await this.openVaultPath(targetPath, normalizeOpenKind(params && (params.kind || params.target), targetPath));
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
    await leaf.openFile(file, { active: true });
    this.app.workspace.revealLeaf(leaf);
    this.rememberMarkdownLeaf(leaf);
    this.setOperationStatus("Opened " + kind + ": " + file.path + ".", "success");
    return true;
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
      if (leaf.view && leaf.view.file && leaf.view.file.path === filePath) {
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
      const view = leaf.view;
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

  setOperationStatus(message, tone) {
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

  rememberMarkdownView(view, leaf) {
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

  getSelectedCanvasMarkdownFileTarget(view, options) {
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

  rememberCanvasMarkdownFile(view, filePath, options) {
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
        const raw = await this.app.vault.cachedRead(view.file);
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
    const markdown = await this.app.vault.cachedRead(file);
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
    const markdown = await this.app.vault.cachedRead(file);
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
    const markdown = await this.app.vault.cachedRead(file);
    const annotations = extractAnnotationContents(markdown);
    this.debugLog("annotations.extract", {
      notePath: file.path,
      annotationCount: annotations.length,
      annotationPreviews: annotations.slice(0, 5).map((annotation) => previewText(annotation)),
      markdownHasAnnoOpen: markdown.includes(ANNO_TAG_PREFIX),
      markdownHasAnnoClose: markdown.includes(ANNO_TAG_SUFFIX),
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
      annotations: annotations.map((content, index) => ({
        index: index + 1,
        content,
      })),
    };

    try {
      this.debugLog("annotations.send.start", {
        notePath: file.path,
        sessionId: payload.sessionId,
        turnId: payload.turnId,
        annotationCount: payload.annotations.length,
      });
      const result = await postJson(joinUrl(this.settings.bridgeUrl, "/api/obsidian/annotations"), payload);
      this.debugLog("annotations.send.ok", {
        notePath: file.path,
        sessionId: payload.sessionId,
        pendingPromptId: result.pendingPromptId || null,
        annotationCount: payload.annotations.length,
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
    const markdown = await this.app.vault.cachedRead(file);
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
      markdown = await this.app.vault.cachedRead(file);
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
    const matches = Array.from(source.matchAll(ANNO_REGEX));
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

class LegacyAnnotationBlockRenderChild extends MarkdownRenderChild {
  constructor(containerEl, plugin, content, sourcePath) {
    super(containerEl);
    this.plugin = plugin;
    this.content = content;
    this.sourcePath = sourcePath || "";
  }

  onload() {
    this.containerEl.empty();
    this.containerEl.addClass("amo-legacy-annotation-section");

    const wrapper = createAnnotationRichShell();
    const body = wrapper.querySelector(".anno-token-content");
    this.containerEl.appendChild(wrapper);

    if (!body) return;
    if (normalizeAnnotationContent(this.content).length === 0) {
      body.textContent = EMPTY_ANNO_TEXT;
      return;
    }

    void renderNestedMarkdown(this.plugin.app, this.content, body, this.sourcePath, this).catch((error) => {
      body.textContent = normalizeAnnotationContent(this.content) || EMPTY_ANNO_TEXT;
      this.plugin.debugLog("render.legacy_render_error", {
        sourcePath: this.sourcePath,
        message: messageFromError(error),
      });
    });
  }

  onunload() {
    this.containerEl.removeClass("amo-legacy-annotation-section");
  }
}

class LegacyAnnotationHiddenSectionRenderChild extends MarkdownRenderChild {
  onload() {
    this.containerEl.empty();
    this.containerEl.addClass("amo-legacy-annotation-hidden-section");
  }

  onunload() {
    this.containerEl.removeClass("amo-legacy-annotation-hidden-section");
  }
}

class AnnotationInputModal extends Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.modalEl.addClass("anno-modal");
    this.titleEl.setText("Append Annotation");
    this.contentEl.createEl("p", { text: "Append a [!anno]...[/anno] block to the current note." });

    this.inputComponent = new TextAreaComponent(this.contentEl);
    this.inputComponent.setPlaceholder("Annotation");
    this.inputComponent.inputEl.addClass("anno-modal-input");
    this.inputComponent.inputEl.rows = 6;

    const actions = this.contentEl.createDiv({ cls: "anno-modal-actions" });
    new ButtonComponent(actions)
      .setButtonText("Append")
      .setCta()
      .onClick(async () => {
        await this.submit();
      });

    new ButtonComponent(actions)
      .setButtonText("Cancel")
      .onClick(() => {
        this.close();
      });

    this.scope.register([], "Enter", (event) => {
      if (!event.ctrlKey && !event.metaKey) return true;
      void this.submit();
      return false;
    });

    window.setTimeout(() => this.inputComponent.inputEl.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }

  async submit() {
    await this.onSubmit(this.inputComponent.getValue());
    this.close();
  }
}

class CanvasNoteTargetModal extends Modal {
  constructor(app, targets, actionLabel, onSelect) {
    super(app);
    this.targets = targets;
    this.actionLabel = actionLabel || "Use";
    this.onSelect = onSelect;
  }

  onOpen() {
    this.modalEl.addClass("anno-modal");
    this.titleEl.setText("Choose Canvas Note");
    this.contentEl.createEl("p", {
      text: "AMO could not read the current canvas selection reliably. Choose the note to use.",
    });

    const list = this.contentEl.createDiv({ cls: "amo-canvas-note-list" });
    for (const target of this.targets) {
      const row = list.createDiv({ cls: "amo-canvas-note-row" });
      row.createDiv({
        cls: "amo-canvas-note-name",
        text: canvasTargetDisplayName(target.file.path),
      });
      row.createDiv({
        cls: "amo-canvas-note-path",
        text: target.file.path,
      });
      new ButtonComponent(row)
        .setButtonText(this.actionLabel)
        .setCta()
        .onClick(async () => {
          await this.submit(target);
        });
    }

    const actions = this.contentEl.createDiv({ cls: "anno-modal-actions" });
    new ButtonComponent(actions)
      .setButtonText("Cancel")
      .onClick(() => {
        this.close();
      });
  }

  onClose() {
    this.contentEl.empty();
  }

  async submit(target) {
    await this.onSelect(target);
    this.close();
  }
}

class AmoAnnotationPanelView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return AMO_PANEL_VIEW_TYPE;
  }

  getDisplayText() {
    return "AMO";
  }

  getIcon() {
    return "panel-right";
  }

  async onOpen() {
    this.render();
  }

  render() {
    void this.renderAsync();
  }

  async renderAsync() {
    const root = this.contentEl;
    root.empty();
    root.addClass("amo-panel");

    root.createEl("h3", { text: "AMO" });

    const status = this.plugin.operationStatus || { tone: "neutral", message: "Ready.", at: null };
    const statusEl = root.createDiv({ cls: "amo-panel-status amo-panel-status-" + status.tone });
    statusEl.createEl("strong", { text: status.message });
    if (status.at) statusEl.createEl("span", { text: formatTime(status.at) });

    let info;
    try {
      info = await this.plugin.getActiveNoteInfo();
    } catch (error) {
      root.createDiv({
        cls: "amo-panel-error",
        text: "Could not read active note: " + messageFromError(error),
      });
      return;
    }

    const summary = root.createDiv({ cls: "amo-panel-section" });
    summary.createEl("h4", { text: "Current note" });
    if (info.file) {
      createInfoRow(summary, "File", info.file.path);
      createInfoRow(summary, "Source", formatNoteTargetSource(info.source));
      createInfoRow(summary, "Session", info.amo.sessionId || "Missing AMO metadata");
      createInfoRow(summary, "Turn", info.amo.turnId || "-");
      createInfoRow(summary, "Annotations", String(info.annotations.length));
      this.plugin.debugLog("panel.render.note", {
        notePath: info.file.path,
        source: info.source,
        annotationCount: info.annotations.length,
        activeLeafType: this.plugin.activeLeafType(),
      });
    } else {
      summary.createDiv({
        cls: "amo-panel-muted",
        text:
          info.source === "canvas-selection-missing"
            ? "Select a Markdown note node on the canvas."
            : "No active Markdown note.",
      });
    }

    const actions = root.createDiv({ cls: "amo-panel-section amo-panel-actions" });
    actions.createEl("h4", { text: "Actions" });
    this.addButton(
      actions,
      "Send to AMO",
      () => {
        if (!info.file) return;
        this.plugin.debugLog("panel.send.clicked", {
          notePath: info.file.path,
          source: info.source,
        });
        void this.plugin.sendAnnotationsFromFile(info.file);
      },
      Boolean(info.file)
    );
    this.addButton(
      actions,
      "Copy annotations",
      () => {
        if (!info.file) return;
        this.plugin.debugLog("panel.copy.clicked", {
          notePath: info.file.path,
          source: info.source,
        });
        void this.plugin.copyAnnotationsFromFile(info.file);
      },
      Boolean(info.file)
    );
    this.addButton(actions, "Append annotation", () => {
      if (!info.file) return;
      new AnnotationInputModal(this.app, async (value) => {
        await this.plugin.appendAnnotationToFile(info.file, value);
      }).open();
    }, Boolean(info.file));
    this.addButton(
      actions,
      "Insert marker",
      () => this.plugin.insertAnnotationFromCurrentSelection(),
      this.plugin.canInsertAnnotationAtActiveEditor() || getWindowSelectionText().length > 0
    );
    this.addButton(actions, "Check bridge", () => this.plugin.checkBridgeHealth(), true);
    this.addButton(actions, "Refresh", () => this.render(), true);

    const bridge = root.createDiv({ cls: "amo-panel-section" });
    bridge.createEl("h4", { text: "Bridge" });
    createInfoRow(bridge, "URL", this.plugin.settings.bridgeUrl);
  }

  addButton(container, label, onClick, enabled) {
    const button = new ButtonComponent(container);
    button.setButtonText(label);
    button.setDisabled(!enabled);
    button.buttonEl.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.onClick(() => {
      void onClick();
    });
    return button;
  }
}

function buildAnnotationMarkup(content) {
  return ANNO_TAG_PREFIX + sanitizeAnnotationContent(content) + ANNO_TAG_SUFFIX;
}

function buildReferencedAnnotationMarkup(reference) {
  return ANNO_TAG_PREFIX + "\n" + formatMarkdownQuote(reference) + "\n\n" + ANNO_TAG_SUFFIX;
}

function insertReferencedAnnotation(editor, selection) {
  const reference = normalizeAnnotationContent(selection);
  if (!reference) {
    const cursor = editor.getCursor();
    editor.replaceSelection(ANNO_TAG_PREFIX + ANNO_TAG_SUFFIX);
    editor.setCursor({
      line: cursor.line,
      ch: cursor.ch + ANNO_TAG_PREFIX.length,
    });
    return;
  }

  const to = editor.getCursor("to") || editor.getCursor();
  const targetLine = Number.isSafeInteger(to.line) ? to.line : editor.getCursor().line;
  const lineText = typeof editor.getLine === "function" ? editor.getLine(targetLine) || "" : "";
  const insertAt = {
    line: targetLine,
    ch: lineText.length,
  };
  const leading = lineText.trim().length > 0 ? "\n\n" : "";
  const quote = formatMarkdownQuote(reference);
  const block = leading + ANNO_TAG_PREFIX + "\n" + quote + "\n\n" + ANNO_TAG_SUFFIX;
  const beforeAnswer = leading + ANNO_TAG_PREFIX + "\n" + quote + "\n";

  editor.replaceRange(block, insertAt);
  editor.setCursor({
    line: insertAt.line + beforeAnswer.split("\n").length - 1,
    ch: 0,
  });
}

function formatMarkdownQuote(content) {
  return sanitizeAnnotationContent(content)
    .split("\n")
    .map((line) => (line.length > 0 ? "> " + line : ">"))
    .join("\n");
}

function sanitizeAnnotationContent(content) {
  return normalizeAnnotationContent(content).replaceAll(ANNO_TAG_SUFFIX, "[/ anno]");
}

function extractAnnotationContents(markdown) {
  return Array.from(markdown.matchAll(ANNO_REGEX))
    .map((match) => normalizeAnnotationContent(match[1] || ""))
    .filter((content) => content.length > 0);
}

function normalizeAnnotationContent(value) {
  return String(value || "").replace(/\r\n?/gu, "\n").trim();
}

function normalizeVaultFilePath(value) {
  return String(value || "")
    .replace(/\\/gu, "/")
    .replace(/^\/+/u, "")
    .trim();
}

function toVaultRelativeProtocolPath(value, vaultRoot) {
  const rawPath = String(value || "").trim();
  if (!rawPath) return "";

  const normalizedPath = rawPath.replace(/\\/gu, "/");
  if (!vaultRoot) return normalizedPath;

  const normalizedRoot = String(vaultRoot || "").replace(/\\/gu, "/").replace(/\/+$/u, "");
  const rootPrefix = normalizedRoot + "/";
  if (normalizedPath.toLowerCase() === normalizedRoot.toLowerCase()) return "";
  if (normalizedPath.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
    return normalizedPath.slice(rootPrefix.length);
  }

  return normalizedPath;
}

function normalizeOpenKind(value, filePath) {
  const kind = String(value || "").trim().toLowerCase();
  if (kind === "canvas" || kind === "note") return kind;
  return String(filePath || "").toLowerCase().endsWith(".canvas") ? "canvas" : "note";
}

function collectCanvasSelectedNodes(canvas) {
  if (!canvas) return [];

  const selectedItems = [];
  for (const source of [canvas.selectedNodes, canvas.selectedItems, canvas.selected]) {
    selectedItems.push(...selectedCollectionValues(source));
  }

  const selection = canvas.selection;
  selectedItems.push(...selectedCollectionValues(selection));
  if (selection && typeof selection === "object") {
    for (const key of ["selected", "selectedNodes", "selectedItems", "nodes", "items", "_selected"]) {
      selectedItems.push(...selectedCollectionValues(selection[key]));
    }
  }

  const allNodes = collectCanvasNodes(canvas);
  const nodes = [];
  const seen = new Set();

  for (const item of selectedItems) {
    const node = resolveCanvasSelectionItem(canvas, allNodes, item);
    if (!node || seen.has(node)) continue;
    seen.add(node);
    nodes.push(node);
  }

  if (nodes.length > 0) return nodes;

  for (const node of allNodes) {
    if (!node || seen.has(node)) continue;
    if (node.selected || node.isSelected || (node.data && node.data.selected)) {
      seen.add(node);
      nodes.push(node);
    }
  }

  return nodes;
}

function selectedCollectionValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return Array.from(value);
  if (value instanceof Map) return Array.from(value.values());
  if (typeof value.values === "function" && typeof value !== "string") {
    try {
      return Array.from(value.values());
    } catch {
      return [];
    }
  }
  return [];
}

function collectCanvasNodes(canvas) {
  const nodes = [];
  for (const source of [canvas.nodes, canvas.nodeMap, canvas.nodesById]) {
    nodes.push(...collectionValues(source));
  }
  return nodes;
}

function canvasFilePathFromEventTarget(canvas, target) {
  const element = target instanceof Element ? target : null;
  if (!element) return "";

  const nodeEl = element.closest(".canvas-node") || element.closest("[data-node-id], [data-path], [data-file]");
  if (!nodeEl) return "";

  const datasetPath = firstNonEmpty(
    nodeEl.dataset && nodeEl.dataset.path,
    nodeEl.dataset && nodeEl.dataset.file,
    datasetValueFromDescendant(nodeEl, "path"),
    datasetValueFromDescendant(nodeEl, "file")
  );
  if (datasetPath) return normalizeVaultFilePath(datasetPath);

  const nodeId = firstNonEmpty(
    nodeEl.dataset && nodeEl.dataset.nodeId,
    nodeEl.dataset && nodeEl.dataset.id,
    nodeEl.getAttribute("data-node-id"),
    nodeEl.id
  );
  if (nodeId) {
    const node = collectCanvasNodes(canvas).find((candidate) => {
      return candidate && (candidate.id === nodeId || (candidate.data && candidate.data.id === nodeId));
    });
    const filePath = node ? canvasNodeFilePath(canvas, node) : "";
    if (filePath) return filePath;
  }

  const visibleText = normalizeAnnotationContent(nodeEl.textContent || "");
  if (!visibleText) return "";

  const fileNodes = collectCanvasNodes(canvas)
    .map((node) => canvasNodeFilePath(canvas, node))
    .filter((filePath) => filePath && filePath.toLowerCase().endsWith(".md"));
  const exact = fileNodes.find((filePath) => visibleText.includes(filePath));
  if (exact) return exact;

  return (
    fileNodes.find((filePath) => {
      const basename = filePath.split("/").pop() || "";
      const stem = basename.replace(/\.md$/iu, "");
      return Boolean(stem && visibleText.includes(stem));
    }) || ""
  );
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function datasetValueFromDescendant(root, key) {
  const el = root.querySelector("[data-" + key + "]");
  return el && el.dataset ? el.dataset[key] : "";
}

function collectionValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return Array.from(value);
  if (value instanceof Map) return Array.from(value.values());
  if (typeof value.values === "function" && typeof value !== "string") {
    try {
      return Array.from(value.values());
    } catch {
      return [];
    }
  }
  if (typeof value === "object") return Object.values(value);
  return [];
}

function resolveCanvasSelectionItem(canvas, allNodes, item) {
  if (!item) return null;
  if (typeof item === "string") {
    return allNodes.find((node) => node && (node.id === item || (node.data && node.data.id === item))) || null;
  }
  if (item.node) return item.node;
  if (item.item) return item.item;
  if (item.value) return item.value;
  if (item.id || item.file || item.filePath || item.path || item.data) return item;
  return null;
}

function canvasNodeFilePath(canvas, node) {
  const data = safeCall(() => (typeof node.getData === "function" ? node.getData() : null));
  const file = safeCall(() => (typeof node.getFile === "function" ? node.getFile() : null));
  const candidates = [
    file,
    node.file,
    node.filePath,
    node.path,
    node.data && node.data.file,
    node.data && node.data.path,
    data && data.file,
    data && data.path,
  ];

  for (const candidate of candidates) {
    const filePath = normalizeCanvasFilePathCandidate(candidate);
    if (filePath) return filePath;
  }

  const nodeId = node.id || (node.data && node.data.id);
  if (!nodeId) return "";
  const match = collectCanvasNodes(canvas).find((candidate) => candidate && candidate.id === nodeId && candidate !== node);
  return match ? canvasNodeFilePath(canvas, match) : "";
}

function normalizeCanvasFilePathCandidate(candidate) {
  if (!candidate) return "";
  if (typeof candidate === "string") return normalizeVaultFilePath(candidate);
  if (typeof candidate.path === "string") return normalizeVaultFilePath(candidate.path);
  if (typeof candidate.file === "string") return normalizeVaultFilePath(candidate.file);
  if (candidate.file && typeof candidate.file.path === "string") return normalizeVaultFilePath(candidate.file.path);
  return "";
}

function safeCall(callback) {
  try {
    return callback();
  } catch {
    return null;
  }
}

function formatAnnotationsForClipboard(annotations) {
  return annotations.join("\n\n");
}

function canvasTargetDisplayName(filePath) {
  const name = String(filePath || "").split(/[\\/]/u).pop() || String(filePath || "");
  return name.replace(/\.md$/iu, "");
}

function createAnnotationElement(content, isStandalone) {
  const wrapper = document.createElement("span");
  wrapper.classList.add("anno-token");
  if (isStandalone) wrapper.classList.add("anno-token-block");

  const badge = document.createElement("span");
  badge.classList.add("anno-token-badge");
  badge.textContent = ANNOTATION_DEFAULT_LABEL;
  wrapper.appendChild(badge);

  const body = document.createElement("span");
  body.classList.add("anno-token-content");
  body.textContent = content || EMPTY_ANNO_TEXT;
  wrapper.appendChild(body);

  return wrapper;
}

function createAnnotationRichShell() {
  const wrapper = document.createElement("div");
  wrapper.classList.add("anno-token", "anno-token-block", "anno-token-rich");
  wrapper.setAttribute("data-amo-annotation", "rich");

  const badge = document.createElement("span");
  badge.classList.add("anno-token-badge");
  badge.textContent = ANNOTATION_DEFAULT_LABEL;
  wrapper.appendChild(badge);

  const body = document.createElement("div");
  body.classList.add("anno-token-content");
  wrapper.appendChild(body);

  return wrapper;
}

function parseLegacyAnnotationBlocks(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/gu, "\n").split("\n");
  const blocks = [];
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex] || "";
    const startIndex = line.indexOf(ANNO_TAG_PREFIX);
    if (startIndex < 0 || line.slice(0, startIndex).trim().length > 0) {
      lineIndex += 1;
      continue;
    }

    const contentLines = [];
    const afterStart = line.slice(startIndex + ANNO_TAG_PREFIX.length);
    const sameLineEnd = afterStart.indexOf(ANNO_TAG_SUFFIX);
    if (sameLineEnd >= 0) {
      if (afterStart.slice(sameLineEnd + ANNO_TAG_SUFFIX.length).trim().length > 0) {
        lineIndex += 1;
        continue;
      }
      contentLines.push(afterStart.slice(0, sameLineEnd));
      blocks.push({
        startLine: lineIndex,
        endLine: lineIndex,
        ownerLine: lineIndex,
        content: normalizeLegacyAnnotationBody(contentLines),
      });
      lineIndex += 1;
      continue;
    }

    contentLines.push(afterStart);
    let endLine = -1;
    for (let cursor = lineIndex + 1; cursor < lines.length; cursor += 1) {
      const endIndex = lines[cursor].indexOf(ANNO_TAG_SUFFIX);
      if (endIndex < 0) {
        contentLines.push(lines[cursor]);
        continue;
      }

      if (lines[cursor].slice(endIndex + ANNO_TAG_SUFFIX.length).trim().length > 0) {
        break;
      }
      contentLines.push(lines[cursor].slice(0, endIndex));
      endLine = cursor;
      break;
    }

    if (endLine >= 0) {
      blocks.push({
        startLine: lineIndex,
        endLine,
        ownerLine: findLegacyAnnotationOwnerLine(lines, lineIndex, endLine, afterStart),
        content: normalizeLegacyAnnotationBody(contentLines),
      });
      lineIndex = endLine + 1;
      continue;
    }

    lineIndex += 1;
  }

  return blocks;
}

function normalizeLegacyAnnotationBody(lines) {
  return String(Array.isArray(lines) ? lines.join("\n") : lines || "")
    .replace(/^\n+/u, "")
    .replace(/\n+$/u, "");
}

function findLegacyAnnotationOwnerLine(lines, startLine, endLine, afterStart) {
  if (normalizeAnnotationContent(afterStart).length > 0) return startLine;

  for (let lineIndex = startLine + 1; lineIndex <= endLine; lineIndex += 1) {
    const rawLine = String(lines[lineIndex] || "");
    const suffixIndex = rawLine.indexOf(ANNO_TAG_SUFFIX);
    const content = suffixIndex >= 0 ? rawLine.slice(0, suffixIndex) : rawLine;
    if (normalizeAnnotationContent(content).length > 0) return lineIndex;
  }

  return startLine;
}

function findLegacyAnnotationBlockForSection(blocks, section) {
  const lineStart = Number(section && section.lineStart);
  const lineEnd = Number(section && section.lineEnd);
  if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) return null;

  for (const block of blocks || []) {
    if (!lineRangesOverlap(lineStart, lineEnd, block.startLine, block.endLine)) continue;
    return Object.assign(
      {
        role: lineRangesOverlap(lineStart, lineEnd, block.ownerLine, block.ownerLine) ? "start" : "hidden",
      },
      block
    );
  }

  return null;
}

function lineRangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

async function renderNestedMarkdown(app, markdown, element, sourcePath, component) {
  if (MarkdownRenderer && typeof MarkdownRenderer.render === "function") {
    await MarkdownRenderer.render(app, markdown, element, sourcePath, component);
    return;
  }

  if (MarkdownRenderer && typeof MarkdownRenderer.renderMarkdown === "function") {
    await MarkdownRenderer.renderMarkdown(markdown, element, sourcePath, component);
    return;
  }

  element.textContent = normalizeAnnotationContent(markdown) || EMPTY_ANNO_TEXT;
}

function parseAmoFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result = {};
  let inAmo = false;
  for (const line of match[1].split(/\r?\n/u)) {
    if (/^amo:\s*$/u.test(line)) {
      inAmo = true;
      continue;
    }
    if (!inAmo) continue;
    if (/^\S/u.test(line)) break;

    const field = line.match(/^  ([A-Za-z0-9_-]+):\s*(.*)$/u);
    if (field) result[field[1]] = parseYamlScalar(field[2]);
  }

  return result;
}

function parseYamlScalar(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "null") return "";
  if (trimmed.startsWith("\"")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

function rootContainsAnnotationMarkers(root) {
  return Boolean(
    root &&
      typeof root.textContent === "string" &&
      (root.textContent.includes(ANNO_TAG_PREFIX) || root.textContent.includes(ANNO_TAG_SUFFIX))
  );
}

function previewText(value, limit) {
  const normalized = normalizeAnnotationContent(value || "");
  const maxLength = Number.isFinite(Number(limit)) ? Number(limit) : 180;
  return normalized.length > maxLength ? normalized.slice(0, maxLength) + "..." : normalized;
}

function describeElement(element) {
  if (!(element instanceof Element)) return "";
  const tag = element.tagName.toLowerCase();
  const id = element.id ? "#" + element.id : "";
  const classes = Array.from(element.classList || [])
    .slice(0, 6)
    .map((className) => "." + className)
    .join("");
  const path = element.getAttribute("data-path") || element.getAttribute("data-file") || "";
  return tag + id + classes + (path ? "[path=" + path + "]" : "");
}

function getVaultRoot(app) {
  const adapter = app.vault.adapter;
  if (adapter && typeof adapter.getBasePath === "function") return adapter.getBasePath();
  return null;
}

function joinUrl(root, path) {
  return String(root || DEFAULT_SETTINGS.bridgeUrl).replace(/\/+$/u, "") + path;
}

async function fetchJson(url) {
  if (typeof fetch !== "function") throw new Error("fetch is unavailable in this Obsidian runtime");

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.ok === false) {
      throw new Error((body && body.message) || "AMO bridge returned " + response.status);
    }
    return body;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function postJson(url, payload) {
  if (typeof fetch !== "function") throw new Error("fetch is unavailable in this Obsidian runtime");

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.ok === false) {
      throw new Error((body && body.message) || "AMO bridge returned " + response.status);
    }
    return body;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function postDebugLog(url, payload) {
  if (typeof fetch !== "function") return;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 1800);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Debug logging is best-effort and must never break Obsidian actions.
  } finally {
    window.clearTimeout(timeout);
  }
}

async function writeTextToClipboard(value) {
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    throw new Error("Clipboard API is unavailable");
  }
  await navigator.clipboard.writeText(value);
}

function getWindowSelectionText() {
  try {
    const selection = window.getSelection && window.getSelection();
    return normalizeAnnotationContent(selection ? selection.toString() : "");
  } catch {
    return "";
  }
}

function messageFromError(error) {
  return error instanceof Error ? error.message : String(error);
}

function createInfoRow(container, label, value) {
  const row = container.createDiv({ cls: "amo-panel-info-row" });
  row.createEl("span", { text: label });
  row.createEl("code", { text: value || "-" });
  return row;
}

function formatNoteTargetSource(source) {
  if (source === "active-note") return "Active note";
  if (source === "canvas-selection") return "Canvas selection";
  if (source === "last-note") return "Last note";
  return "Unknown";
}

function formatTime(value) {
  try {
    return new Date(value).toLocaleTimeString();
  } catch {
    return "";
  }
}

module.exports = AmoMarkdownAnnotationToolsPlugin;
