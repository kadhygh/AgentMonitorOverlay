import { MarkdownView, Notice, Plugin, setIcon } from "obsidian";
import { EditorView } from "@codemirror/view";
import {
  AMO_CANVAS_OPEN_NOTE_ACTION_CLASS,
  AMO_CANVAS_PANEL_ACTION_CLASS,
  AMO_CANVAS_MANAGER,
  AMO_CANVAS_SEND_ACTION_CLASS,
  AMO_CANVAS_TITLE_ACTION_CLASS,
  AMO_CANVAS_TYPE,
  AMO_OPEN_PROTOCOL,
  AMO_NOTE_PROPERTIES_ACTION_CLASS,
  AMO_PANEL_ACTION_CLASS,
  AMO_PANEL_VIEW_TYPE,
  AMO_SEND_ACTION_CLASS,
  AMO_TITLE_ACTION_CLASS,
  ANNO_TAG_PREFIX,
  ANNO_TAG_SUFFIX,
  DEFAULT_CANVAS_PATH,
  DEFAULT_SETTINGS,
  PLUGIN_VERSION,
} from "./core/constants";
import { fetchJson, joinUrl, postDebugLog, postJson, writeTextToClipboard } from "./core/api";
import { normalizeVaultFilePath } from "./core/paths";
import { normalizeMarkdownTitle, parseAmoMetadata, removeAmoDisplayHeading, upsertAmoMarker } from "./core/metadata";
import { getVaultRoot, getWindowSelectionText, messageFromError, previewText, rootContainsAnnotationMarkers, describeElement } from "./core/ui-utils";
import { AmoAnnotationPanelView } from "./ui/panel-view";
import { AnnotationInputModal, CanvasNoteTargetModal, NoteTitleModal } from "./ui/modals";
import { AmoAnnotationSettingTab } from "./ui/settings-tab";
import {
  buildAnnotationMarkup,
  buildReferencedAnnotationMarkup,
  extractAnnotationContents,
  extractAnnotationItems,
  formatAnnotationsForClipboard,
  findAnnotationItemAtOffset,
  insertReferencedAnnotation,
  normalizeAnnotationContent,
  removeAnnotationByIndex,
} from "./annotations/syntax";
import {
  findLegacyAnnotationBlockForSection,
  linkifyLocalCodeLinks,
  parseLegacyAnnotationBlocks,
  replaceInlineAnnotations,
  LegacyAnnotationBlockRenderChild,
  LegacyAnnotationHiddenSectionRenderChild,
} from "./annotations/render";
import { amoMarkerHiderExtension } from "./editor/amo-marker-hider";
import { handleEditorLocalCodeLinkEvent, handleLocalCodeLinkClick } from "./editor/local-code-link-controller";
import {
  canvasFilePathFromEventTarget,
  canvasNodeFilePath,
  collectCanvasNodes,
  collectCanvasSelectedNodes,
  normalizeCanvasFilePathCandidate,
} from "./canvas/target";
import { canvasNodeElement, centerCanvasNode, markCanvasLatestNote } from "./canvas/navigation";
import {
  amoNoteSourceTitleHeader,
  displayNameForFile,
  firstAmoNoteContentLine,
  isAmoMetadata,
  syncAmoNoteDisplayTitleView,
} from "./note/title";
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
        const centered = centerCanvasNode(view, node, (target, method, ...args) => this.safeCanvasCall(target, method, ...args));
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
        continue;
      }
      await this.syncAmoCanvasNodeLabels(view);
      this.syncCanvasOpenNoteToolbarButtons(view);
    }
  }

  clearAmoCanvasRendering(view) {
    if (!view || !view.containerEl) return;
    view.containerEl.classList.remove("amo-managed-canvas");
    this.clearAmoCanvasNodeLabels(view);
    this.clearCanvasOpenNoteToolbarButtons(view);
  }

  async syncAmoCanvasNodeLabels(view) {
    if (!view || !view.containerEl || !view.canvas) return;

    const titleByPath = new Map();
    for (const node of collectCanvasNodes(view.canvas)) {
      const nodeFilePath = normalizeVaultFilePath(canvasNodeFilePath(view.canvas, node));
      if (!nodeFilePath || !nodeFilePath.toLowerCase().endsWith(".md")) continue;

      const nodeElement = canvasNodeElement(view, node);
      const labelElement = this.canvasNodeLabelElement(nodeElement);
      if (!labelElement) continue;

      let displayTitle = titleByPath.get(nodeFilePath);
      if (displayTitle === undefined) {
        displayTitle = await this.amoDisplayTitleForPath(nodeFilePath);
        titleByPath.set(nodeFilePath, displayTitle);
      }

      this.applyCanvasNodeDisplayTitle(labelElement, displayTitle);
    }
  }

  async amoDisplayTitleForPath(filePath) {
    const normalizedPath = normalizeVaultFilePath(filePath);
    const file = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!file) return "";

    try {
      const markdown = await this.app.vault.cachedRead(file as any);
      const amo = parseAmoMetadata(markdown);
      return normalizeMarkdownTitle(amo.displayTitle);
    } catch (error) {
      this.debugLog("canvas.label.read_error", {
        notePath: normalizedPath,
        message: messageFromError(error),
      });
      return "";
    }
  }

  canvasNodeLabelElement(nodeElement) {
    if (!(nodeElement instanceof HTMLElement)) return null;

    for (const selector of [
      ":scope > .canvas-node-label",
      ".canvas-node-label",
      ".canvas-node-title",
      "[data-amo-canvas-node-label]",
    ]) {
      const candidate = nodeElement.querySelector(selector);
      if (candidate instanceof HTMLElement) return candidate;
    }

    return null;
  }

  applyCanvasNodeDisplayTitle(labelElement, displayTitle) {
    if (!(labelElement instanceof HTMLElement)) return;
    if (!labelElement.dataset.amoOriginalLabel) {
      labelElement.dataset.amoOriginalLabel = labelElement.textContent || "";
    }

    const normalizedTitle = normalizeMarkdownTitle(displayTitle);
    if (normalizedTitle) {
      labelElement.textContent = normalizedTitle;
      labelElement.title = normalizedTitle;
      labelElement.classList.add("amo-canvas-display-title-label");
      return;
    }

    this.restoreCanvasNodeLabel(labelElement);
  }

  clearAmoCanvasNodeLabels(view) {
    if (!view || !view.containerEl) return;
    for (const labelElement of Array.from(view.containerEl.querySelectorAll("[data-amo-original-label]"))) {
      this.restoreCanvasNodeLabel(labelElement);
    }
  }

  restoreCanvasNodeLabel(labelElement) {
    if (!(labelElement instanceof HTMLElement)) return;
    const originalLabel = labelElement.dataset.amoOriginalLabel || "";
    if (originalLabel) {
      labelElement.textContent = originalLabel;
    }
    labelElement.removeAttribute("title");
    labelElement.classList.remove("amo-canvas-display-title-label");
    delete labelElement.dataset.amoOriginalLabel;
  }

  syncCanvasOpenNoteToolbarButtons(view) {
    if (!view || !view.containerEl || !view.canvas) return;

    const notePath = this.selectedCanvasMarkdownNotePath(view);
    const toolbars = this.canvasNodeToolbarElements(view);
    if (!notePath || toolbars.length === 0) {
      this.clearCanvasOpenNoteToolbarButtons(view);
      return;
    }

    for (const toolbar of toolbars) {
      let button = toolbar.querySelector("." + AMO_CANVAS_OPEN_NOTE_ACTION_CLASS) as HTMLButtonElement | null;
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "clickable-icon " + AMO_CANVAS_OPEN_NOTE_ACTION_CLASS;
        button.setAttribute("aria-label", "Open note");
        button.setAttribute("title", "Open note");
        setIcon(button, "file-text");
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const targetPath = button?.dataset.amoNotePath || "";
          void this.openCanvasToolbarNote(view, targetPath);
        });
        toolbar.appendChild(button);
      }

      button.dataset.amoNotePath = notePath;
      button.disabled = false;
    }
  }

  clearCanvasOpenNoteToolbarButtons(view) {
    if (!view || !view.containerEl) return;
    for (const button of Array.from(view.containerEl.querySelectorAll("." + AMO_CANVAS_OPEN_NOTE_ACTION_CLASS))) {
      if (button instanceof HTMLElement) button.remove();
    }
  }

  canvasNodeToolbarElements(view) {
    if (!view || !view.containerEl) return [];
    return Array.from(
      view.containerEl.querySelectorAll(
        ".canvas-node-menu, .canvas-node-toolbar, .canvas-node-controls, .canvas-node-actions"
      )
    ).filter((element) => element instanceof HTMLElement) as HTMLElement[];
  }

  selectedCanvasMarkdownNotePath(view) {
    if (!view || !view.canvas) return "";
    for (const node of collectCanvasSelectedNodes(view.canvas)) {
      const notePath = normalizeVaultFilePath(canvasNodeFilePath(view.canvas, node));
      if (notePath && notePath.toLowerCase().endsWith(".md")) {
        const file = this.app.vault.getAbstractFileByPath(notePath);
        if (file && typeof file.path === "string") return file.path;
      }
    }
    return "";
  }

  async openCanvasToolbarNote(view, notePath) {
    const normalizedPath = normalizeVaultFilePath(notePath);
    if (!normalizedPath) return;

    const file = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!file || typeof file.path !== "string") {
      new Notice("AMO target not found: " + normalizedPath);
      return;
    }

    this.rememberCanvasMarkdownFile(view, file.path);
    this.debugLog("canvas.toolbar.open_note.clicked", {
      canvasPath: view && view.file && view.file.path,
      notePath: file.path,
    });
    await this.openVaultPath(file.path, "note");
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
    const marked = markCanvasLatestNote(view, node);

    this.safeCanvasCall(canvas, "requestFrame");
    this.debugLog("canvas.focus_note.selected", {
      canvasPath: view && view.file && view.file.path,
      notePath,
      nodeId: node && (node.id || (node.data && node.data.id)),
      marked,
    });
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
    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      const view: any = leaf.view;
      if (!view || !view.containerEl || typeof view.addAction !== "function") continue;
      this.ensureCanvasTargetTracking(view);
      this.syncCanvasOpenNoteToolbarButtons(view);

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

      if (!view.containerEl.querySelector("." + AMO_CANVAS_TITLE_ACTION_CLASS)) {
        const titleAction = view.addAction("pencil", "Edit selected note title", () => {
          void this.editTitleFromCanvas(view);
        });
        titleAction.addClass(AMO_CANVAS_TITLE_ACTION_CLASS);
        this.debugLog("canvas.action.added", {
          action: "title",
          canvasPath: view.file && view.file.path,
        });
      }
    }
  }

  async editTitleFromCanvas(view) {
    const rememberedBefore = this.getRememberedCanvasMarkdownFileTarget(view);
    const selectedCount = collectCanvasSelectedNodes(view && view.canvas).length;
    const file = this.getCanvasMarkdownFileForAction(view);
    this.debugLog("canvas.title.clicked", {
      canvasPath: view && view.file && view.file.path,
      targetPath: file && file.path,
      rememberedPathBefore: rememberedBefore && rememberedBefore.file && rememberedBefore.file.path,
      selectedCount,
    });
    if (file) {
      await this.editAmoNoteTitle(file);
      return;
    }

    await this.chooseCanvasMarkdownFile(view, "Edit title", async (selectedFile) => {
      this.rememberCanvasMarkdownFile(view, selectedFile.path);
      await this.editAmoNoteTitle(selectedFile);
    });
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
      this.scheduleCanvasToolbarSync(view);
    });
  }

  scheduleCanvasToolbarSync(view) {
    window.setTimeout(() => this.syncCanvasOpenNoteToolbarButtons(view), 0);
    window.setTimeout(() => this.syncCanvasOpenNoteToolbarButtons(view), 120);
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

  async syncAmoNotePropertyViews() {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      if (!(leaf.view instanceof MarkdownView)) continue;
      const view = leaf.view;
      await this.syncAmoNotePropertyView(view);
    }
  }

  async syncAmoNotePropertyView(view) {
    if (!(view instanceof MarkdownView) || !view.file || !view.containerEl) return;

    const filePath = view.file.path;
    const amo = await this.readAmoMetadataForFile(view.file);
    const isAmoNote = isAmoMetadata(amo);
    if (!view.file || view.file.path !== filePath || !view.containerEl) return;

    view.containerEl.classList.toggle("amo-note-view", isAmoNote);
    const shouldHide =
      isAmoNote &&
      Boolean(this.settings.hideAmoNoteProperties) &&
      !this.amoNotePropertiesExpandedPaths.has(filePath);
    view.containerEl.classList.toggle("amo-hide-note-properties", shouldHide);
    view.containerEl.classList.toggle("amo-show-note-properties", isAmoNote && !shouldHide);
    syncAmoNoteDisplayTitleView(view, isAmoNote ? amo : {});
  }

  async isAmoMarkdownFile(file) {
    if (!file || typeof file.path !== "string") return false;

    const amo = await this.readAmoMetadataForFile(file);
    return isAmoMetadata(amo);
  }

  async readAmoMetadataForFile(file) {
    if (!file || typeof file.path !== "string") return {};

    try {
      const markdown = await this.app.vault.cachedRead(file as any);
      return parseAmoMetadata(markdown);
    } catch {
      return {};
    }
  }

  async toggleAmoNotePropertiesForView(view) {
    if (!(view instanceof MarkdownView) || !view.file) {
      new Notice("No active Markdown note.");
      return;
    }

    const isAmoNote = await this.isAmoMarkdownFile(view.file);
    if (!isAmoNote) {
      new Notice("Current note is not an AMO note.");
      return;
    }

    const filePath = view.file.path;
    if (this.amoNotePropertiesExpandedPaths.has(filePath)) {
      this.amoNotePropertiesExpandedPaths.delete(filePath);
      new Notice("AMO note properties hidden.");
    } else {
      this.amoNotePropertiesExpandedPaths.add(filePath);
      new Notice("AMO note properties shown.");
    }

    await this.syncAmoNotePropertyViews();
  }

  clearAmoNotePropertyViewClasses() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view: any = leaf.view;
      if (!view || !view.containerEl) continue;
      view.containerEl.classList.remove(
        "amo-note-view",
        "amo-hide-note-properties",
        "amo-show-note-properties",
        "amo-note-has-display-title"
      );
      const sourceHeader = amoNoteSourceTitleHeader(view);
      if (sourceHeader) sourceHeader.remove();
    }
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

  async deleteAnnotationFromFile(file, annotationIndex) {
    if (!file || !Number.isSafeInteger(annotationIndex)) {
      new Notice("No annotation selected.");
      return false;
    }

    const markdown = await this.app.vault.cachedRead(file as any);
    const result = removeAnnotationByIndex(markdown, annotationIndex);
    if (!result.removed) {
      new Notice("Annotation not found.");
      return false;
    }

    await this.app.vault.modify(file, result.markdown);
    this.debugLog("annotations.delete.ok", {
      notePath: file.path,
      annotationIndex,
      annotationPreview: previewText(result.item && result.item.content),
    });
    this.setOperationStatus("Deleted annotation " + annotationIndex + " from " + file.path + ".", "success");
    new Notice("Annotation deleted.");
    this.refreshPanels();
    return true;
  }

  async deleteRenderedAnnotation(sourcePath, block) {
    const file = sourcePath ? this.app.vault.getAbstractFileByPath(normalizeVaultFilePath(sourcePath)) : null;
    if (!file || typeof file.path !== "string") {
      new Notice("Could not resolve annotation source note.");
      return false;
    }

    const markdown = await this.app.vault.cachedRead(file as any);
    const items = extractAnnotationItems(markdown);
    const target =
      items.find((item) => item.startLine === block.startLine && item.endLine === block.endLine) ||
      items.find((item) => normalizeAnnotationContent(item.content) === normalizeAnnotationContent(block.content));
    if (!target) {
      new Notice("Annotation not found.");
      return false;
    }

    return this.deleteAnnotationFromFile(file, target.index);
  }

  annotationItemAtEditorCursor(editor) {
    if (!editor || typeof editor.getValue !== "function" || typeof editor.getCursor !== "function") return null;
    const markdown = editor.getValue();
    const cursor = editor.getCursor();
    const offset = this.editorPositionToOffset(markdown, cursor);
    return findAnnotationItemAtOffset(markdown, offset);
  }

  deleteAnnotationAtEditor(editor) {
    const item = this.annotationItemAtEditorCursor(editor);
    if (!item) {
      new Notice("Cursor is not inside an AMO annotation.");
      return false;
    }

    const markdown = editor.getValue();
    const result = removeAnnotationByIndex(markdown, item.index);
    if (!result.removed || !result.range) {
      new Notice("Annotation not found.");
      return false;
    }

    editor.replaceRange(
      "",
      this.editorOffsetToPosition(markdown, result.range.startOffset),
      this.editorOffsetToPosition(markdown, result.range.endOffset)
    );
    this.setOperationStatus("Deleted current annotation.", "success");
    new Notice("Annotation deleted.");
    this.refreshPanels();
    return true;
  }

  editorPositionToOffset(markdown, position) {
    const source = String(markdown || "").replace(/\r\n?/gu, "\n");
    const targetLine = Math.max(0, Number(position && position.line) || 0);
    const targetCh = Math.max(0, Number(position && position.ch) || 0);
    let offset = 0;
    const lines = source.split("\n");
    for (let line = 0; line < Math.min(targetLine, lines.length); line += 1) {
      offset += lines[line].length + 1;
    }
    return Math.min(source.length, offset + targetCh);
  }

  editorOffsetToPosition(markdown, offset) {
    const source = String(markdown || "").replace(/\r\n?/gu, "\n");
    const safeOffset = Math.max(0, Math.min(source.length, Number(offset) || 0));
    let line = 0;
    let lastLineStart = 0;
    for (let index = 0; index < safeOffset; index += 1) {
      if (source.charCodeAt(index) === 10) {
        line += 1;
        lastLineStart = index + 1;
      }
    }
    return {
      line,
      ch: safeOffset - lastLineStart,
    };
  }

  async updateAmoNoteTitle(file, rawTitle) {
    if (!file) {
      new Notice("No active Markdown note.");
      return false;
    }

    const displayTitle = normalizeMarkdownTitle(rawTitle);

    const markdown = await this.app.vault.cachedRead(file as any);
    const amo = parseAmoMetadata(markdown);
    if (!amo.schemaVersion && !amo.sessionId && !amo.noteId && !amo.kind) {
      new Notice("Current note is not an AMO note.");
      return false;
    }

    const metadata = {
      ...amo,
      schemaVersion: amo.schemaVersion || 1,
      displayTitle,
    };
    const withMarker = upsertAmoMarker(markdown, metadata);
    const nextMarkdown = removeAmoDisplayHeading(withMarker, amo.displayTitle, amo.displayName || displayNameForFile(file));
    await this.app.vault.modify(file, nextMarkdown);

    try {
      await postJson(joinUrl(this.settings.bridgeUrl, "/api/obsidian/note-title"), {
        schemaVersion: 1,
        source: "obsidian-md-anno-tools",
        vaultRoot: getVaultRoot(this.app),
        notePath: file.path,
        noteId: amo.noteId || null,
        displayTitle,
      });
    } catch (error) {
      this.debugLog("note.title.sync_error", {
        notePath: file.path,
        message: messageFromError(error),
      });
    }

    this.setOperationStatus(displayTitle ? "Updated note title: " + displayTitle : "Cleared AMO note title.", "success");
    new Notice(displayTitle ? "AMO note title updated." : "AMO note title cleared.");
    void this.syncAmoNotePropertyViews();
    void this.syncAmoCanvasRendering();
    this.refreshPanels();
    return true;
  }

  async editAmoNoteTitle(file) {
    if (!file) {
      new Notice("No active Markdown note.");
      return;
    }

    let markdown = "";
    try {
      markdown = await this.app.vault.cachedRead(file as any);
    } catch (error) {
      new Notice("Could not read note: " + messageFromError(error));
      return;
    }

    const amo = parseAmoMetadata(markdown);
    const currentTitle = amo.displayTitle || "";
    new NoteTitleModal(this.app, currentTitle, file.path, async (value) => {
      await this.updateAmoNoteTitle(file, value);
    }).open();
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

    const amo = parseAmoMetadata(markdown);
    this.debugLog("annotations.metadata", {
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
        annotationItems: [],
        amo: {},
        displayTitle: "",
      };
    }

    const file = target.file;
    const markdown = await this.app.vault.cachedRead(file as any);
    const amo = parseAmoMetadata(markdown);
    const annotationItems = extractAnnotationItems(markdown);
    return {
      file,
      source: target.source,
      annotations: annotationItems.map((item) => item.content).filter((content) => content.length > 0),
      annotationItems,
      amo,
      displayTitle: amo.displayTitle || "",
    };
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
    if (!(root instanceof HTMLElement) || !context || typeof context.getSectionInfo !== "function") return false;
    if (root.querySelector(".amo-note-display-header")) return true;

    const section = context.getSectionInfo(root);
    if (!section || typeof section.text !== "string") return false;

    const file = context.sourcePath ? this.app.vault.getAbstractFileByPath(normalizeVaultFilePath(context.sourcePath)) : null;
    if (!file || typeof file.path !== "string") return false;

    let markdown = "";
    try {
      markdown = await this.app.vault.cachedRead(file as any);
    } catch {
      return false;
    }

    const amo = parseAmoMetadata(markdown);
    const displayTitle = normalizeMarkdownTitle(amo.displayTitle);
    if (!displayTitle) return false;

    const firstContentLine = firstAmoNoteContentLine(markdown);
    if (firstContentLine < 0) return false;

    const lineStart = Number(section.lineStart);
    const lineEnd = Number(section.lineEnd);
    if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) return false;
    if (!(lineStart <= firstContentLine && firstContentLine <= lineEnd)) return false;

    const header = document.createElement("div");
    header.classList.add("amo-note-display-header");
    header.setAttribute("data-amo-note-title", "true");

    const title = header.createDiv({ cls: "amo-note-display-title" });
    title.setText(displayTitle);

    const originalName = amo.displayName || displayNameForFile(file);
    if (originalName) {
      const subtitle = header.createDiv({ cls: "amo-note-display-subtitle" });
      subtitle.setText(originalName);
    }

    root.prepend(header);
    return true;
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
