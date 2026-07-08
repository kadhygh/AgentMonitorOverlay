import { MarkdownView, Notice, Plugin } from "obsidian";
import { EditorView } from "@codemirror/view";
import {
  AMO_CANVAS_OPEN_NOTE_ACTION_CLASS,
  AMO_CANVAS_PANEL_ACTION_CLASS,
  AMO_CANVAS_SEND_ACTION_CLASS,
  AMO_CANVAS_TITLE_ACTION_CLASS,
  AMO_OPEN_PROTOCOL,
  AMO_NOTE_PROPERTIES_ACTION_CLASS,
  AMO_PANEL_ACTION_CLASS,
  AMO_PANEL_VIEW_TYPE,
  AMO_SEND_ACTION_CLASS,
  AMO_TITLE_ACTION_CLASS,
  DEFAULT_CANVAS_PATH,
  DEFAULT_SETTINGS,
  PLUGIN_VERSION,
} from "./core/constants";
import { joinUrl, postDebugLog, writeTextToClipboard } from "./core/api";
import { normalizeVaultFilePath } from "./core/paths";
import { parseAmoMetadata } from "./core/metadata";
import { getVaultRoot, getWindowSelectionText, messageFromError, previewText, rootContainsAnnotationMarkers, describeElement } from "./core/ui-utils";
import { AmoAnnotationPanelView } from "./ui/panel-view";
import { AnnotationInputModal } from "./ui/modals";
import { AmoAnnotationSettingTab } from "./ui/settings-tab";
import {
  extractAnnotationItems,
  formatAnnotationsForClipboard,
} from "./annotations/syntax";
import * as annotationCommands from "./annotations/commands";
import {
  findLegacyAnnotationBlockForSection,
  linkifyLocalCodeLinks,
  parseLegacyAnnotationBlocks,
  replaceInlineAnnotations,
  LegacyAnnotationBlockRenderChild,
  LegacyAnnotationHiddenSectionRenderChild,
} from "./annotations/render";
import {
  checkBridgeHealthAction,
  copyAnnotationsFromFileAction,
  sendAnnotationsFromFileAction,
} from "./bridge/annotation-sync";
import { amoMarkerHiderExtension } from "./editor/amo-marker-hider";
import { handleEditorLocalCodeLinkEvent, handleLocalCodeLinkClick } from "./editor/local-code-link-controller";
import * as canvasActions from "./canvas/actions";
import { centerCanvasNode } from "./canvas/navigation";
import * as canvasRendering from "./canvas/rendering";
import * as workCanvasActions from "./canvas/work-canvas";
import * as noteTitleActions from "./note/title-actions";
import * as noteProperties from "./note/properties";
import { handleAmoOpenProtocol, openVaultPath as openAmoVaultPath } from "./protocol/amo-open";


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
  amoNotePropertiesExpandedPaths: Set<string>;
  panelRefreshTimer: number | null;
  codeLinkSuppressUntilMs: number;
  codeLinkSuppressTarget: string;
  sendToAmoShortcutSuppressUntilMs: number;

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
    this.amoNotePropertiesExpandedPaths = new Set();
    this.panelRefreshTimer = null;
    this.codeLinkSuppressUntilMs = 0;
    this.codeLinkSuppressTarget = "";
    this.sendToAmoShortcutSuppressUntilMs = 0;

    this.registerView(AMO_PANEL_VIEW_TYPE, (leaf) => new AmoAnnotationPanelView(leaf, this));
    this.registerEditorExtension(amoMarkerHiderExtension);
    this.registerEditorExtension(
      EditorView.domEventHandlers({
        mousedown: (event, view) =>
          this.handleEditorAnnotationMouseShortcut(event, view, "mousedown") ||
          handleEditorLocalCodeLinkEvent(this, event, view, "mousedown"),
        auxclick: (event, view) => this.handleEditorAnnotationMouseShortcut(event, view, "auxclick"),
        click: (event, view) => handleEditorLocalCodeLinkEvent(this, event, view, "click"),
      })
    );
    this.addSettingTab(new AmoAnnotationSettingTab(this.app, this));
    this.debugLog("plugin.loaded", {
      version: PLUGIN_VERSION,
      bridgeUrl: this.settings.bridgeUrl,
      localCodeLinkEditor: this.settings.localCodeLinkEditor,
      zedCommand: this.settings.zedCommand,
      vaultRoot: getVaultRoot(this.app),
    });

    if (typeof this.registerObsidianProtocolHandler === "function") {
      this.registerObsidianProtocolHandler(AMO_OPEN_PROTOCOL, (params) => {
        void handleAmoOpenProtocol(this, params);
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

    this.addCommand({
      id: "delete-current-annotation",
      name: "Delete current AMO annotation",
      editorCallback: (editor) => {
        this.deleteAnnotationAtEditor(editor);
      },
    });

    this.registerMarkdownPostProcessor((el, ctx) => this.renderAnnotations(el, ctx), 1000);
    this.registerDomEvent(
      document,
      "click",
      (event) => {
        handleLocalCodeLinkClick(this, event);
      },
      { capture: true }
    );
    this.registerDomEvent(
      document,
      "mousedown",
      (event) => {
        this.handleSendToAmoMouseShortcut(event);
      },
      { capture: true }
    );
    this.registerDomEvent(
      document,
      "auxclick",
      (event) => {
        this.handleSendToAmoMouseShortcut(event);
      },
      { capture: true }
    );

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const hasSelection = editor.getSelection().trim().length > 0;
        const currentAnnotation = this.annotationItemAtEditorCursor(editor);
        if (currentAnnotation) {
          menu.addItem((item) => {
            item
              .setTitle("Delete current AMO annotation")
              .setIcon("trash")
              .onClick(() => {
                this.deleteAnnotationAtEditor(editor);
              });
          });
        }
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
      void this.syncAmoNotePropertyViews();
      this.refreshPanels();
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.rememberMarkdownLeaf(leaf);
        this.syncMarkdownViewActions();
        this.syncCanvasViewActions();
        void this.syncAmoCanvasRendering();
        void this.syncAmoNotePropertyViews();
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
        void this.syncAmoNotePropertyViews();
        this.refreshPanels();
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.rememberCurrentMarkdownView();
        this.syncMarkdownViewActions();
        this.syncCanvasViewActions();
        void this.syncAmoCanvasRendering();
        void this.syncAmoNotePropertyViews();
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
          AMO_TITLE_ACTION_CLASS +
          ", ." +
          AMO_NOTE_PROPERTIES_ACTION_CLASS +
          ", ." +
          AMO_CANVAS_SEND_ACTION_CLASS +
          ", ." +
          AMO_CANVAS_PANEL_ACTION_CLASS +
          ", ." +
          AMO_CANVAS_TITLE_ACTION_CLASS +
          ", ." +
          AMO_CANVAS_OPEN_NOTE_ACTION_CLASS
      )
      .forEach((el) => el.remove());
    this.clearAmoNotePropertyViewClasses();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    void this.syncAmoNotePropertyViews();
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

  handleEditorAnnotationMouseShortcut(event: MouseEvent, view: EditorView, phase: string) {
    if (!event.ctrlKey || event.button !== 4) return false;

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView) || this.getActiveMarkdownView();
    if (!activeView || !activeView.editor) {
      this.debugLog("annotations.editor_mouse_shortcut.no_editor", {
        phase,
        target: event.target instanceof Element ? describeElement(event.target) : "",
        editorViewClass: view.dom?.className || "",
      });
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.rememberMarkdownView(activeView, this.findLeafForView(activeView));
    this.wrapSelectionWithAnnotation(activeView.editor);
    this.debugLog("annotations.editor_mouse_shortcut.handled", {
      phase,
      hasSelection: activeView.editor.getSelection().trim().length > 0,
      notePath: activeView.file?.path || "",
    });
    return true;
  }

  handleSendToAmoMouseShortcut(event: MouseEvent) {
    if (!event.ctrlKey || event.button !== 4) return false;
    if (event.target instanceof Element && event.target.closest(".cm-editor")) return false;

    const now = Date.now();
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (now < this.sendToAmoShortcutSuppressUntilMs) return true;
    this.sendToAmoShortcutSuppressUntilMs = now + 700;

    const file = this.getActiveMarkdownFile();
    if (!file) {
      this.debugLog("annotations.send.mouse5.no_file", {
        type: event.type,
        target: event.target instanceof Element ? describeElement(event.target) : "",
      });
      new Notice("No active Markdown note.");
      return true;
    }

    this.debugLog("annotations.send.mouse5", {
      notePath: file.path,
      type: event.type,
    });
    void this.sendAnnotationsFromFile(file);
    return true;
  }

  async openVaultPath(filePath, kind) {
    return openAmoVaultPath(this, filePath, kind);
  }

  async focusCanvasNoteNode(canvasPath, notePath, nodeId = null) {
    const normalizedCanvasPath = normalizeVaultFilePath(canvasPath);
    const normalizedNotePath = normalizeVaultFilePath(notePath);
    if (!normalizedCanvasPath || !normalizedNotePath) return false;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const view = this.getCanvasViewForFilePath(normalizedCanvasPath);
      const node = view
        ? (nodeId ? this.findCanvasNodeForId(view, nodeId) : null) || this.findCanvasNodeForFilePath(view, normalizedNotePath)
        : null;
      if (view && node) {
        const managedCanvas = await this.isAmoManagedCanvasView(view);
        if (managedCanvas) {
          this.selectCanvasNode(view, node, normalizedNotePath);
        }
        const centered = centerCanvasNode(view, node, (target, method, ...args) => this.safeCanvasCall(target, method, ...args));
        this.rememberCanvasMarkdownFile(view, normalizedNotePath);
        this.debugLog("canvas.focus_note.ok", {
          canvasPath: normalizedCanvasPath,
          notePath: normalizedNotePath,
          nodeId,
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
    return canvasRendering.isAmoManagedCanvasView(this, view);
  }

  async syncAmoCanvasRendering() {
    return canvasRendering.syncAmoCanvasRendering(this);
  }

  clearAmoCanvasRendering(view) {
    return canvasRendering.clearAmoCanvasRendering(this, view);
  }

  async syncAmoCanvasNodeLabels(view) {
    return canvasRendering.syncAmoCanvasNodeLabels(this, view);
  }

  async amoDisplayTitleForPath(filePath) {
    return canvasRendering.amoDisplayTitleForPath(this, filePath);
  }

  canvasNodeLabelElement(nodeElement) {
    return canvasRendering.canvasNodeLabelElement(nodeElement);
  }

  applyCanvasNodeDisplayTitle(labelElement, displayTitle) {
    return canvasRendering.applyCanvasNodeDisplayTitle(labelElement, displayTitle);
  }

  clearAmoCanvasNodeLabels(view) {
    return canvasRendering.clearAmoCanvasNodeLabels(this, view);
  }

  restoreCanvasNodeLabel(labelElement) {
    return canvasRendering.restoreCanvasNodeLabel(labelElement);
  }

  syncCanvasOpenNoteToolbarButtons(view) {
    return canvasRendering.syncCanvasOpenNoteToolbarButtons(this, view);
  }

  clearCanvasOpenNoteToolbarButtons(view) {
    return canvasRendering.clearCanvasOpenNoteToolbarButtons(view);
  }

  canvasNodeToolbarElements(view) {
    return canvasRendering.canvasNodeToolbarElements(view);
  }

  selectedCanvasMarkdownNotePath(view) {
    return canvasRendering.selectedCanvasMarkdownNotePath(this, view);
  }

  async openCanvasToolbarNote(view, notePath) {
    return canvasRendering.openCanvasToolbarNote(this, view, notePath);
  }

  findCanvasNodeForFilePath(view, notePath) {
    return canvasRendering.findCanvasNodeForFilePath(view, notePath);
  }

  findCanvasNodeForId(view, nodeId) {
    return canvasRendering.findCanvasNodeForId(view, nodeId);
  }

  selectCanvasNode(view, node, notePath) {
    return canvasRendering.selectCanvasNode(this, view, node, notePath);
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

      if (!view.containerEl.querySelector("." + AMO_TITLE_ACTION_CLASS)) {
        const titleAction = view.addAction("pencil", "Edit AMO note title", () => {
          if (!view.file) {
            new Notice("No active Markdown note.");
            return;
          }
          void this.editAmoNoteTitle(view.file);
        });
        titleAction.addClass(AMO_TITLE_ACTION_CLASS);
      }

      if (!view.containerEl.querySelector("." + AMO_NOTE_PROPERTIES_ACTION_CLASS)) {
        const propertiesAction = view.addAction("list-collapse", "Show/hide AMO note properties", () => {
          void this.toggleAmoNotePropertiesForView(view);
        });
        propertiesAction.addClass(AMO_NOTE_PROPERTIES_ACTION_CLASS);
      }
    }
  }

  syncCanvasViewActions() {
    return canvasActions.syncCanvasViewActions(this);
  }

  async editTitleFromCanvas(view) {
    return canvasActions.editTitleFromCanvas(this, view);
  }

  async sendAnnotationsFromCanvas(view) {
    return canvasActions.sendAnnotationsFromCanvas(this, view);
  }

  async openPanelFromCanvas(view) {
    return canvasActions.openPanelFromCanvas(this, view);
  }

  ensureCanvasTargetTracking(view) {
    return canvasActions.ensureCanvasTargetTracking(this, view);
  }

  scheduleCanvasToolbarSync(view) {
    return canvasActions.scheduleCanvasToolbarSync(this, view);
  }

  rememberCanvasTargetFromEvent(view, event) {
    return canvasActions.rememberCanvasTargetFromEvent(this, view, event);
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

  async syncAmoNotePropertyViews() {
    return noteProperties.syncAmoNotePropertyViews(this);
  }

  async syncAmoNotePropertyView(view) {
    return noteProperties.syncAmoNotePropertyView(this, view);
  }

  async isAmoMarkdownFile(file) {
    return noteProperties.isAmoMarkdownFile(this, file);
  }

  async readAmoMetadataForFile(file) {
    return noteProperties.readAmoMetadataForFile(this, file);
  }

  async toggleAmoNotePropertiesForView(view) {
    return noteProperties.toggleAmoNotePropertiesForView(this, view);
  }

  clearAmoNotePropertyViewClasses() {
    return noteProperties.clearAmoNotePropertyViewClasses(this);
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
    return canvasActions.getSelectedCanvasMarkdownFile(this, view);
  }

  getCanvasMarkdownFileForAction(view) {
    return canvasActions.getCanvasMarkdownFileForAction(this, view);
  }

  getSelectedCanvasMarkdownFileTarget(view = null, options = null) {
    return canvasActions.getSelectedCanvasMarkdownFileTarget(this, view, options);
  }

  rememberCanvasMarkdownFile(view, filePath, options = null) {
    return canvasActions.rememberCanvasMarkdownFile(this, view, filePath, options);
  }

  getRememberedCanvasMarkdownFileTarget(view) {
    return canvasActions.getRememberedCanvasMarkdownFileTarget(this, view);
  }

  rememberSelectedCanvasMarkdownFile(view) {
    return canvasActions.rememberSelectedCanvasMarkdownFile(this, view);
  }

  async chooseCanvasMarkdownFile(view, actionLabel, onSelect) {
    return canvasActions.chooseCanvasMarkdownFile(this, view, actionLabel, onSelect);
  }

  async listCanvasMarkdownFileTargets(view) {
    return canvasActions.listCanvasMarkdownFileTargets(this, view);
  }

  addCanvasFileTarget(targets, seen, filePath, x, y) {
    return canvasActions.addCanvasFileTarget(this, targets, seen, filePath, x, y);
  }

  getActiveCanvasView() {
    return canvasActions.getActiveCanvasView(this);
  }

  isActiveLeafCanvas() {
    return canvasActions.isActiveLeafCanvas(this);
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
    return annotationCommands.canInsertAnnotationAtActiveEditor(this);
  }

  canInsertAnnotationAtFileEditor(file) {
    return annotationCommands.canInsertAnnotationAtFileEditor(this, file);
  }

  getMarkdownViewForFile(fileOrPath) {
    return annotationCommands.getMarkdownViewForFile(this, fileOrPath);
  }

  insertAnnotationAtFileEditor(file) {
    return annotationCommands.insertAnnotationAtFileEditor(this, file);
  }

  insertAnnotationAtActiveEditor() {
    return annotationCommands.insertAnnotationAtActiveEditor(this);
  }

  async insertAnnotationFromCurrentSelection() {
    return annotationCommands.insertAnnotationFromCurrentSelection(this);
  }

  wrapSelectionWithAnnotation(editor) {
    return annotationCommands.wrapSelectionWithAnnotation(this, editor);
  }

  async appendReferencedAnnotationToFile(file, reference) {
    return annotationCommands.appendReferencedAnnotationToFile(this, file, reference);
  }

  async insertReferencedAnnotationNearTextInFile(file, reference) {
    return annotationCommands.insertReferencedAnnotationNearTextInFile(this, file, reference);
  }

  async appendAnnotationToFile(file, rawContent) {
    return annotationCommands.appendAnnotationToFile(this, file, rawContent);
  }

  async appendAnnotationBlockToFile(file, block) {
    return annotationCommands.appendAnnotationBlockToFile(this, file, block);
  }

  async deleteAnnotationFromFile(file, annotationIndex) {
    return annotationCommands.deleteAnnotationFromFile(this, file, annotationIndex);
  }

  async deleteRenderedAnnotation(sourcePath, block) {
    return annotationCommands.deleteRenderedAnnotation(this, sourcePath, block);
  }

  annotationItemAtEditorCursor(editor) {
    return annotationCommands.annotationItemAtEditorCursor(this, editor);
  }

  deleteAnnotationAtEditor(editor) {
    return annotationCommands.deleteAnnotationAtEditor(this, editor);
  }

  async updateAmoNoteTitle(file, rawTitle) {
    return noteTitleActions.updateAmoNoteTitle(this, file, rawTitle);
  }

  async editAmoNoteTitle(file) {
    return noteTitleActions.editAmoNoteTitle(this, file);
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
    await copyAnnotationsFromFileAction(this, file);
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
    await sendAnnotationsFromFileAction(this, file);
  }

  async checkBridgeHealth() {
    await checkBridgeHealthAction(this);
  }

  async getActiveNoteInfo() {
    const target = this.getActiveMarkdownFileTarget();
    if (!target || !target.file) {
      return {
        file: null,
        source: this.isActiveLeafCanvas() ? "canvas-selection-missing" : "none",
        annotations: [],
        annotationItems: [],
        amo: {},
        displayTitle: "",
        isAmoNote: false,
        activeLeafType: this.activeLeafType(),
      };
    }

    const file = target.file;
    const markdown = await this.app.vault.cachedRead(file as any);
    const amo = parseAmoMetadata(markdown);
    const annotationItems = extractAnnotationItems(markdown);
    const isAmoNote = Boolean(amo.schemaVersion || amo.sessionId || amo.noteId || amo.kind);
    return {
      file,
      source: target.source,
      annotations: annotationItems.map((item) => item.content).filter((content) => content.length > 0),
      annotationItems,
      amo,
      displayTitle: amo.displayTitle || "",
      isAmoNote,
      activeLeafType: this.activeLeafType(),
    };
  }

  getPanelCanvasFile() {
    const view = this.getActiveCanvasView() || this.lastCanvasView;
    return view && view.file && typeof view.file.path === "string" ? view.file : null;
  }

  async revealFileInExplorer(fileOrPath) {
    const file =
      typeof fileOrPath === "string"
        ? this.app.vault.getAbstractFileByPath(normalizeVaultFilePath(fileOrPath))
        : fileOrPath;
    if (!file || typeof file.path !== "string") {
      new Notice("No file to reveal.");
      return false;
    }

    let leaves = this.app.workspace.getLeavesOfType("file-explorer");
    const commands = (this.app as any).commands;
    if (leaves.length === 0 && commands && typeof commands.executeCommandById === "function") {
      try {
        await commands.executeCommandById("file-explorer:open");
      } catch {
        // The file explorer command may be unavailable in some Obsidian builds.
      }
      leaves = this.app.workspace.getLeavesOfType("file-explorer");
    }

    for (const leaf of leaves) {
      const view = leaf && (leaf.view as any);
      if (view && typeof view.revealInFolder === "function") {
        this.app.workspace.revealLeaf(leaf);
        await view.revealInFolder(file);
        this.setOperationStatus("Revealed file: " + file.path + ".", "success");
        return true;
      }
    }

    this.setOperationStatus("Could not reveal file in Obsidian explorer: " + file.path + ".", "error");
    new Notice("Could not reveal file in Obsidian explorer.");
    return false;
  }

  async copyAnnotationItemFromFile(file, annotationIndex) {
    const markdown = await this.app.vault.cachedRead(file as any);
    const item = extractAnnotationItems(markdown).find((candidate) => candidate.index === annotationIndex);
    if (!item) {
      new Notice("Annotation not found.");
      return false;
    }

    await writeTextToClipboard(formatAnnotationsForClipboard([item.content]));
    this.setOperationStatus("Copied annotation " + annotationIndex + " from " + file.path + ".", "success");
    new Notice("Annotation copied.");
    return true;
  }

  async focusAnnotationItemInFile(file, item) {
    if (!file || !item) {
      new Notice("Annotation not found.");
      return false;
    }

    await this.openVaultPath(file.path, "note");
    await this.delay(80);
    const leaf = this.findMarkdownLeafForFilePath(file.path);
    const view = leaf && leaf.view instanceof MarkdownView ? leaf.view : null;
    if (leaf) {
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    }
    if (view && view.editor) {
      const from = { line: Math.max(0, item.startLine || 0), ch: 0 };
      const to = { line: Math.max(0, item.endLine || item.startLine || 0), ch: 0 };
      view.editor.setCursor(from);
      if (typeof view.editor.scrollIntoView === "function") {
        view.editor.scrollIntoView({ from, to }, true);
      }
      this.setOperationStatus("Focused annotation " + item.index + " in " + file.path + ".", "success");
      return true;
    }

    this.setOperationStatus("Opened note but could not focus annotation " + item.index + ".", "neutral");
    return false;
  }

  async openAddNoteToWorkCanvasModal(file) {
    return workCanvasActions.openAddNoteToWorkCanvasModal(this, file);
  }

  workCanvasFolderPath() {
    return workCanvasActions.workCanvasFolderPath(this);
  }

  async listWorkCanvasTargets(noteFile) {
    return workCanvasActions.listWorkCanvasTargets(this, noteFile);
  }

  async canvasContainsNote(canvasFile, notePath) {
    return workCanvasActions.canvasContainsNote(this, canvasFile, notePath);
  }

  async createWorkCanvasFolder(rawName) {
    return workCanvasActions.createWorkCanvasFolder(this, rawName);
  }

  async createWorkCanvas(rawName) {
    return workCanvasActions.createWorkCanvas(this, rawName);
  }

  async addNoteToWorkCanvas(noteFile, canvasPath) {
    return workCanvasActions.addNoteToWorkCanvas(this, noteFile, canvasPath);
  }

  nextWorkCanvasNodePosition(nodes) {
    return workCanvasActions.nextWorkCanvasNodePosition(nodes);
  }

  uniqueCanvasNodeId(nodes, prefix) {
    return workCanvasActions.uniqueCanvasNodeId(nodes, prefix);
  }

  async ensureVaultFolder(folderPath) {
    return workCanvasActions.ensureVaultFolder(this, folderPath);
  }

  async vaultPathExists(path) {
    return workCanvasActions.vaultPathExists(this, path);
  }

  async nextAvailableVaultPath(path) {
    return workCanvasActions.nextAvailableVaultPath(this, path);
  }

  safeVaultPathSegment(value) {
    return workCanvasActions.safeVaultPathSegment(value);
  }

  safeVaultFileName(value) {
    return workCanvasActions.safeVaultFileName(value);
  }

  async renderAnnotations(root, context) {
    await this.renderAmoNoteDisplayHeader(root, context);

    if (await this.renderLegacyAnnotationSection(root, context)) return;

    if (rootContainsAnnotationMarkers(root)) {
      this.debugLog("render.postprocessor", {
        root: describeElement(root),
        preview: previewText(root.textContent || ""),
      });
    }

    replaceInlineAnnotations(root);
    if (this.settings.interceptLocalCodeLinks !== false) linkifyLocalCodeLinks(root);
  }

  async renderAmoNoteDisplayHeader(root, context) {
    return noteTitleActions.renderAmoNoteDisplayHeader(this, root, context);
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
      context.addChild(new LegacyAnnotationBlockRenderChild(root, this, block, context.sourcePath));
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

}

export default AmoMarkdownAnnotationToolsPlugin;
