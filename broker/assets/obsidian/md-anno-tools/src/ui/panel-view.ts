import { ItemView, Notice, setIcon } from "obsidian";
import { AMO_PANEL_VIEW_TYPE } from "../core/constants";
import {
  createInfoRow,
  formatNoteTargetSource,
  formatTime,
  getWindowSelectionText,
  messageFromError,
  previewText,
} from "../core/ui-utils";
import { AnnotationInputModal } from "./modals";
import type { AmoMarkdownAnnotationToolsPlugin } from "../plugin";

export class AmoAnnotationPanelView extends ItemView {
  plugin: AmoMarkdownAnnotationToolsPlugin;
  editingTitle: boolean;
  editingTitleFilePath: string;
  editingTitleValue: string;
  renderRevision: number;

  constructor(leaf: any, plugin: AmoMarkdownAnnotationToolsPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.editingTitle = false;
    this.editingTitleFilePath = "";
    this.editingTitleValue = "";
    this.renderRevision = 0;
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
    const revision = ++this.renderRevision;
    void this.renderAsync(revision);
  }

  async renderAsync(revision: number) {
    let info;
    let workCanvasTargets: any[] = [];
    try {
      info = await this.plugin.getActiveNoteInfo();
    } catch (error) {
      if (revision !== this.renderRevision) return;
      const root = this.contentEl;
      root.empty();
      root.addClass("amo-panel");
      this.renderHeader(root, this.workspaceStateFor(null, null));
      root.createDiv({
        cls: "amo-panel-error",
        text: "Could not read active note: " + messageFromError(error),
      });
      return;
    }

    if (info.file) {
      workCanvasTargets = await this.plugin.listWorkCanvasTargets(info.file);
    }

    if (revision !== this.renderRevision) {
      this.plugin.debugLog("panel.render.stale_result_ignored", {
        revision,
        currentRevision: this.renderRevision,
        notePath: info.file && info.file.path,
        source: info.source,
      });
      return;
    }

    const root = this.contentEl;
    root.empty();
    root.addClass("amo-panel");

    const canvasFile = this.plugin.getPanelCanvasFile();
    const workspaceState = this.workspaceStateFor(info, canvasFile);
    this.renderHeader(root, workspaceState);
    this.renderCurrentNote(root, info, workCanvasTargets);
    this.renderActions(root, info, canvasFile, workspaceState);
    this.renderAnnotations(root, info);
    this.renderOperationStatus(root);
    this.renderDetails(root, info, canvasFile, workspaceState);

    this.plugin.debugLog("panel.render.note", {
      notePath: info.file && info.file.path,
      source: info.source,
      annotationCount: info.annotations.length,
      activeLeafType: info.activeLeafType,
      canvasPath: canvasFile && canvasFile.path,
      workspaceState: workspaceState.key,
    });
  }

  renderHeader(root: HTMLElement, workspaceState: any) {
    const header = root.createDiv({ cls: "amo-panel-heading" });
    header.createEl("h3", { text: "AMO" });

    const state = header.createDiv({
      cls: "amo-panel-workspace-state amo-panel-workspace-state-" + workspaceState.key,
      attr: {
        title: workspaceState.title,
        "aria-label": workspaceState.title,
      },
    });
    setIcon(state.createSpan({ cls: "amo-panel-workspace-state-icon" }), workspaceState.icon);
    state.createSpan({ cls: "amo-panel-workspace-state-label", text: workspaceState.label });
  }

  renderOperationStatus(root: HTMLElement) {
    const status = this.plugin.operationStatus || { tone: "neutral", message: "Ready.", at: null };
    const statusEl = root.createDiv({ cls: "amo-panel-status amo-panel-status-" + status.tone });
    statusEl.createEl("strong", { text: status.message });
    if (status.at) statusEl.createEl("span", { text: formatTime(status.at) });
  }

  renderCurrentNote(root: HTMLElement, info: any, workCanvasTargets: any[]) {
    const section = root.createDiv({ cls: "amo-panel-current-note-card" });
    const header = section.createDiv({ cls: "amo-panel-current-note-header" });
    header.createEl("h4", { text: "Opened note" });

    if (info.file) {
      const linkedCanvasCount = (Array.isArray(workCanvasTargets) ? workCanvasTargets : []).filter(
        (target) => target.containsNote
      ).length;
      const linkSummary = header.createDiv({
        cls: "amo-panel-current-work-canvas-count",
        attr: {
          title:
            linkedCanvasCount === 1
              ? "Linked to 1 work canvas"
              : "Linked to " + linkedCanvasCount + " work canvases",
          "aria-label":
            linkedCanvasCount === 1
              ? "Linked to 1 work canvas"
              : "Linked to " + linkedCanvasCount + " work canvases",
        },
      });
      setIcon(linkSummary.createSpan({ cls: "amo-panel-current-work-canvas-icon" }), "layout-template");
      linkSummary.createSpan({ text: String(linkedCanvasCount) });
    }

    if (!info.file) {
      section.createDiv({
        cls: "amo-panel-muted",
        text:
          info.source === "canvas-selection-missing"
            ? "Select a Markdown note node on the canvas."
            : "No active Markdown note.",
      });
      this.resetTitleEdit();
      return;
    }

    if (this.editingTitle && this.editingTitleFilePath !== info.file.path) {
      this.resetTitleEdit();
    }

    if (this.editingTitle) {
      this.renderTitleEditor(section, info);
    } else {
      const titleRow = section.createDiv({ cls: "amo-panel-current-title-row" });
      const titleEl = titleRow.createDiv({
        cls: "amo-panel-current-title" + (info.isAmoNote ? " is-editable" : ""),
        text: this.panelTitleForInfo(info),
        attr: info.isAmoNote
          ? {
              role: "button",
              tabindex: "0",
              title: "Click to edit AMO note title",
            }
          : {},
      });
      if (info.isAmoNote) {
        titleEl.addEventListener("mousedown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        titleEl.addEventListener("click", () => {
          void this.startCurrentTitleEdit(info);
        });
        titleEl.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          void this.startCurrentTitleEdit(info);
        });
      }

      if (info.displayTitle) {
        section.createDiv({
          cls: "amo-panel-current-original-title",
          text: this.fileNameForPath(info.file.path),
        });
      }
    }

    section.createDiv({
      cls: "amo-panel-current-path",
      text: info.file.path,
    });

    const quickActions = section.createDiv({ cls: "amo-panel-current-quick-actions" });
    this.addActionButton(
      quickActions,
      "folder-search",
      "定位",
      async () => {
        const currentInfo = await this.requireCurrentInfo(info, "quick-reveal-note");
        if (currentInfo) await this.plugin.revealFileInExplorer(currentInfo.file);
      },
      true,
      "Reveal the current note in the file explorer."
    );
  }

  renderTitleEditor(container: HTMLElement, info: any) {
    const editor = container.createDiv({ cls: "amo-panel-title-edit" });
    const row = editor.createDiv({ cls: "amo-panel-title-edit-row" });
    const input = row.createEl("textarea", {
      attr: {
        placeholder: "AMO note title",
        rows: "3",
      },
    }) as HTMLTextAreaElement;
    input.value = this.editingTitleValue;
    input.addEventListener("input", () => {
      this.editingTitleValue = input.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        void this.saveTitleEdit(info, input.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.resetTitleEdit();
        this.render();
      }
    });
    input.addEventListener("blur", () => {
      this.editingTitleValue = input.value;
    });

    const actions = row.createDiv({ cls: "amo-panel-title-edit-actions" });
    const saveButton = actions.createEl("button", {
      cls: "amo-panel-title-icon-button",
      attr: {
        type: "button",
        title: "Save title",
        "aria-label": "Save title",
      },
    }) as HTMLButtonElement;
    setIcon(saveButton, "check");
    saveButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    saveButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.saveTitleEdit(info, input.value);
    });

    const cancelButton = actions.createEl("button", {
      cls: "amo-panel-title-icon-button",
      attr: {
        type: "button",
        title: "Cancel title edit",
        "aria-label": "Cancel title edit",
      },
    }) as HTMLButtonElement;
    setIcon(cancelButton, "x");
    cancelButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    cancelButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.resetTitleEdit();
      this.render();
    });

    editor.createDiv({
      cls: "amo-panel-title-edit-hint",
      text: "Enter saves. Shift+Enter adds a new line. Esc cancels.",
    });
    container.createDiv({
      cls: "amo-panel-current-original-title",
      text: this.fileNameForPath(info.file.path),
    });

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  renderActions(root: HTMLElement, info: any, canvasFile: any, workspaceState: any) {
    const section = root.createDiv({ cls: "amo-panel-section amo-panel-actions" });
    section.createEl("h4", { text: "Actions" });

    const isCanvasNoteContext = workspaceState.key === "canvas-note" || info.source === "canvas-selection";
    const canvasNoteEditDisabledTitle = isCanvasNoteContext
      ? "Canvas selected-note mode only supports returning to the task window and revealing the note. Open the note tab for annotation edits."
      : "";
    const noteGroup = section.createDiv({
      cls: "amo-panel-action-group" + (info.file ? "" : " is-disabled"),
    });
    const noteHeader = noteGroup.createDiv({ cls: "amo-panel-action-group-header" });
    setIcon(noteHeader.createSpan(), "file-text");
    noteHeader.createSpan({ text: "Note" });
    const noteButtons = noteGroup.createDiv({ cls: "amo-panel-action-grid" });
    this.addActionButton(
      noteButtons,
      "highlighter",
      "批注",
      () => this.insertAnnotation(info),
      Boolean(info.file && !isCanvasNoteContext),
      canvasNoteEditDisabledTitle
    );
    this.addActionButton(
      noteButtons,
      "send",
      "返回窗口",
      async () => {
        const currentInfo = await this.requireCurrentInfo(info, "return-window");
        if (!currentInfo) return;
        this.plugin.debugLog("panel.return_window.resolve", {
          renderedNotePath: info.file && info.file.path,
          resolvedNotePath: currentInfo.file && currentInfo.file.path,
          renderedSource: info.source,
          resolvedSource: currentInfo.source,
          activeLeafType: this.plugin.activeLeafType(),
        });
        if (!currentInfo.isAmoNote) {
          new Notice("Only AMO-created notes can return annotations to a task window.");
          this.render();
          return;
        }
        await this.plugin.sendAnnotationsFromFile(currentInfo.file);
      },
      Boolean(info.file && info.isAmoNote),
      info.file && !info.isAmoNote ? "Only AMO-created notes can return annotations to a task window." : ""
    );
    this.addActionButton(
      noteButtons,
      "copy",
      "复制批注",
      async () => {
        const currentInfo = await this.requireCurrentInfo(info, "copy-annotations");
        if (!currentInfo) return;
        this.plugin.debugLog("panel.copy.clicked", {
          notePath: currentInfo.file.path,
          source: currentInfo.source,
        });
        await this.plugin.copyAnnotationsFromFile(currentInfo.file);
      },
      Boolean(info.file && !isCanvasNoteContext),
      canvasNoteEditDisabledTitle
    );
    this.addActionButton(
      noteButtons,
      "folder-search",
      "定位笔记",
      async () => {
        const currentInfo = await this.requireCurrentInfo(info, "reveal-note");
        if (currentInfo) await this.plugin.revealFileInExplorer(currentInfo.file);
      },
      Boolean(info.file)
    );
    this.addActionButton(
      noteButtons,
      "layout-template",
      "加入工作画布",
      async () => {
        const currentInfo = await this.requireCurrentInfo(info, "add-to-work-canvas");
        if (currentInfo) await this.plugin.openAddNoteToWorkCanvasModal(currentInfo.file);
      },
      Boolean(info.file && !isCanvasNoteContext),
      canvasNoteEditDisabledTitle
    );
    this.addActionButton(
      noteButtons,
      "map-pin",
      "前往工作画布",
      async () => {
        const currentInfo = await this.requireCurrentInfo(info, "go-to-work-canvas");
        if (currentInfo) await this.plugin.openWorkCanvasForNote(currentInfo.file);
      },
      Boolean(info.file),
      "Open a work canvas associated with this note."
    );
    const canvasActionsEnabled = Boolean(canvasFile && (workspaceState.key === "canvas" || workspaceState.key === "canvas-note"));
    const canvasGroup = section.createDiv({
      cls: "amo-panel-action-group" + (canvasActionsEnabled ? "" : " is-disabled"),
    });
    const canvasHeader = canvasGroup.createDiv({ cls: "amo-panel-action-group-header" });
    setIcon(canvasHeader.createSpan(), "layout-dashboard");
    canvasHeader.createSpan({ text: "Canvas" });
    const canvasButtons = canvasGroup.createDiv({ cls: "amo-panel-action-grid" });
    this.addActionButton(
      canvasButtons,
      "file-input",
      "打开笔记",
      async () => {
        const currentInfo = await this.requireCurrentInfo(info, "open-canvas-note");
        if (!currentInfo) return;
        if (currentInfo.source !== "canvas-selection") {
          new Notice("Canvas note selection changed. Select the note again.");
          this.render();
          return;
        }
        await this.plugin.openVaultPath(currentInfo.file.path, "note");
      },
      Boolean(canvasActionsEnabled && info.file),
      "Open the selected canvas note."
    );
    this.addActionButton(
      canvasButtons,
      "folder-search",
      "定位画布",
      async () => {
        const currentCanvas = this.plugin.getPanelCanvasFile();
        if (!currentCanvas) {
          new Notice("No active Canvas file.");
          this.render();
          return;
        }
        if (canvasFile && currentCanvas.path !== canvasFile.path) {
          this.plugin.debugLog("panel.action.live_canvas_changed", {
            action: "reveal-canvas",
            fallbackPath: canvasFile.path,
            livePath: currentCanvas.path,
          });
        }
        await this.plugin.revealFileInExplorer(currentCanvas);
      },
      canvasActionsEnabled,
      "Reveal the active canvas file in the file explorer."
    );
  }

  renderAnnotations(root: HTMLElement, info: any) {
    const annotationItems = info.annotationItems || [];
    if (!info.file || annotationItems.length === 0) return;

    const section = root.createDiv({ cls: "amo-panel-section" });
    section.createEl("h4", { text: "Annotations" });
    const list = section.createDiv({ cls: "amo-panel-annotation-list" });
    for (const item of annotationItems) {
      const row = list.createDiv({ cls: "amo-panel-annotation-row" });
      row.createDiv({
        cls: "amo-panel-annotation-preview",
        text: previewText(item.content || "(empty annotation)", 160),
      });
      const actions = row.createDiv({ cls: "amo-panel-annotation-actions" });
      this.addActionButton(
        actions,
        "copy",
        "复制",
        async () => {
          const currentInfo = await this.requireRenderedInfo(info, "copy-annotation-item");
          if (currentInfo) await this.plugin.copyAnnotationItemFromFile(currentInfo.file, item.index);
        },
        true
      );
      this.addActionButton(
        actions,
        "locate-fixed",
        "跳转",
        async () => {
          const currentInfo = await this.requireRenderedInfo(info, "focus-annotation-item");
          if (currentInfo) await this.plugin.focusAnnotationItemInFile(currentInfo.file, item);
        },
        true
      );
      this.addActionButton(
        actions,
        "trash-2",
        "删除",
        async () => {
          const currentInfo = await this.requireRenderedInfo(info, "delete-annotation-item");
          if (!currentInfo) return;
          await this.plugin.deleteAnnotationFromFile(currentInfo.file, item.index);
          this.render();
        },
        true
      );
    }
  }

  renderDetails(root: HTMLElement, info: any, canvasFile: any, workspaceState: any) {
    const details = root.createEl("details", { cls: "amo-panel-section amo-panel-details" });
    details.createEl("summary", { text: "Current note details" });

    if (info.file) {
      createInfoRow(details, "File", info.file.path);
      createInfoRow(details, "Source", formatNoteTargetSource(info.source));
      createInfoRow(details, "Session", info.amo.sessionId || "Missing AMO metadata");
      createInfoRow(details, "Turn", info.amo.turnId || "-");
      createInfoRow(details, "Annotations", String(info.annotations.length));
      createInfoRow(details, "Title", info.displayTitle || "-");
    } else {
      details.createDiv({
        cls: "amo-panel-muted",
        text:
          info.source === "canvas-selection-missing"
            ? "Canvas is active, but no Markdown note node is selected."
            : "No active Markdown note.",
      });
    }

    createInfoRow(details, "Workspace", workspaceState.title);
    createInfoRow(details, "Canvas", canvasFile && canvasFile.path ? canvasFile.path : "-");
    createInfoRow(details, "Bridge URL", this.plugin.settings.bridgeUrl);
  }

  workspaceStateFor(info: any, canvasFile: any) {
    const activeLeafType = (info && info.activeLeafType) || this.plugin.activeLeafType();
    const source = info && info.source;

    if (activeLeafType === "canvas" || source === "canvas-selection-missing") {
      if (info && info.file && source === "canvas-selection") {
        return {
          key: "canvas-note",
          icon: "mouse-pointer-square-dashed",
          label: "Canvas note",
          title: "Canvas is focused and a Markdown note node is selected.",
        };
      }
      return {
        key: "canvas",
        icon: "layout-dashboard",
        label: "Canvas",
        title: canvasFile ? "Canvas is focused: " + canvasFile.path : "Canvas is focused.",
      };
    }

    if (activeLeafType === AMO_PANEL_VIEW_TYPE && source === "canvas-selection") {
      return {
        key: "canvas-note",
        icon: "history",
        label: "Canvas note",
        title: "AMO panel is focused; using the last selected canvas note.",
      };
    }

    if (activeLeafType === "markdown" || source === "active-note" || source === "last-note") {
      return {
        key: "note",
        icon: "file-text",
        label: "Note",
        title: "Markdown note context is active.",
      };
    }

    if (activeLeafType === AMO_PANEL_VIEW_TYPE && info && info.file) {
      return {
        key: "retained",
        icon: "history",
        label: "Retained",
        title: "AMO panel is focused; using the last valid note context.",
      };
    }

    return {
      key: "none",
      icon: "circle-help",
      label: "No note",
      title: "No note or canvas note context is active.",
    };
  }

  async insertAnnotation(info: any) {
    info = await this.currentInfoForAction(info, "insert-annotation");
    if (!info || !info.file) return;

    const activeLeafType = this.plugin.activeLeafType();
    if (activeLeafType === "canvas" || info.source === "canvas-selection") {
      const selectedText = getWindowSelectionText();
      if (selectedText) {
        await this.plugin.appendReferencedAnnotationToFile(info.file, selectedText);
      } else {
        new AnnotationInputModal(this.app, async (value) => {
          await this.plugin.appendAnnotationToFile(info.file, value);
        }).open();
      }
      return;
    }

    const selectedText = getWindowSelectionText();
    if (selectedText) {
      await this.plugin.insertReferencedAnnotationNearTextInFile(info.file, selectedText);
      return;
    }

    if (this.plugin.canInsertAnnotationAtFileEditor(info.file)) {
      this.plugin.insertAnnotationAtFileEditor(info.file);
      return;
    }

    new AnnotationInputModal(this.app, async (value) => {
      await this.plugin.appendAnnotationToFile(info.file, value);
    }).open();
  }

  async currentInfoForAction(fallbackInfo: any, action: string) {
    try {
      const liveInfo = await this.plugin.getActiveNoteInfo();
      const fallbackPath = fallbackInfo && fallbackInfo.file && fallbackInfo.file.path;
      const livePath = liveInfo && liveInfo.file && liveInfo.file.path;
      if (livePath && livePath !== fallbackPath) {
        this.plugin.debugLog("panel.action.live_note_changed", {
          action,
          fallbackPath,
          livePath,
          fallbackSource: fallbackInfo && fallbackInfo.source,
          liveSource: liveInfo && liveInfo.source,
          activeLeafType: this.plugin.activeLeafType(),
        });
      }
      return liveInfo;
    } catch (error) {
      this.plugin.debugLog("panel.action.live_note_error", {
        action,
        message: messageFromError(error),
      });
      return null;
    }
  }

  async requireCurrentInfo(fallbackInfo: any, action: string) {
    const currentInfo = await this.currentInfoForAction(fallbackInfo, action);
    if (currentInfo && currentInfo.file) return currentInfo;

    this.plugin.debugLog("panel.action.no_current_note", {
      action,
      fallbackPath: fallbackInfo && fallbackInfo.file && fallbackInfo.file.path,
      fallbackSource: fallbackInfo && fallbackInfo.source,
      activeLeafType: this.plugin.activeLeafType(),
    });
    new Notice("No active Markdown note. The AMO panel has been refreshed.");
    this.render();
    return null;
  }

  async requireRenderedInfo(fallbackInfo: any, action: string) {
    const currentInfo = await this.requireCurrentInfo(fallbackInfo, action);
    if (!currentInfo) return null;

    const renderedPath = fallbackInfo && fallbackInfo.file && fallbackInfo.file.path;
    if (currentInfo.file.path === renderedPath) return currentInfo;

    this.plugin.debugLog("panel.action.stale_rendered_item", {
      action,
      renderedPath,
      currentPath: currentInfo.file.path,
      renderedSource: fallbackInfo && fallbackInfo.source,
      currentSource: currentInfo.source,
    });
    new Notice("The active note changed. Choose the annotation again from the refreshed panel.");
    this.render();
    return null;
  }

  addActionButton(
    container: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void | Promise<void>,
    enabled: boolean,
    title = ""
  ) {
    const button = container.createEl("button", {
      cls: "amo-panel-action-button",
      attr: {
        type: "button",
        title: title || label,
      },
    }) as HTMLButtonElement;
    button.disabled = !enabled;
    setIcon(button.createSpan({ cls: "amo-panel-action-icon" }), icon);
    button.createSpan({ cls: "amo-panel-action-label", text: label });
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!enabled) return;
      void onClick();
    });
    return button;
  }

  startTitleEdit(info: any) {
    if (!info.file || !info.isAmoNote) return;
    this.editingTitle = true;
    this.editingTitleFilePath = info.file.path;
    this.editingTitleValue = info.displayTitle || "";
    this.render();
  }

  async startCurrentTitleEdit(info: any) {
    const currentInfo = await this.requireCurrentInfo(info, "edit-title");
    if (!currentInfo) return;
    if (!currentInfo.isAmoNote) {
      new Notice("Only AMO-created notes have an AMO title.");
      this.render();
      return;
    }
    this.startTitleEdit(currentInfo);
  }

  async saveTitleEdit(info: any, value: string) {
    const currentInfo = await this.requireRenderedInfo(info, "save-title");
    if (!currentInfo || currentInfo.file.path !== this.editingTitleFilePath) {
      this.resetTitleEdit();
      this.render();
      return;
    }
    const saved = await this.plugin.updateAmoNoteTitle(currentInfo.file, value);
    if (saved) {
      this.resetTitleEdit();
      this.render();
    }
  }

  resetTitleEdit() {
    this.editingTitle = false;
    this.editingTitleFilePath = "";
    this.editingTitleValue = "";
  }

  panelTitleForInfo(info: any) {
    return info.displayTitle || this.fileNameForPath(info.file.path);
  }

  fileNameForPath(path: string) {
    return String(path || "").split("/").pop() || String(path || "");
  }
}
