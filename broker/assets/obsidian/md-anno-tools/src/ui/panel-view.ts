import { ButtonComponent, ItemView } from "obsidian";
import { AMO_PANEL_VIEW_TYPE } from "../core/constants";
import { getWindowSelectionText, messageFromError, createInfoRow, formatNoteTargetSource, formatTime, previewText } from "../core/ui-utils";
import { AnnotationInputModal } from "./modals";
import type { AmoMarkdownAnnotationToolsPlugin } from "../plugin";

export class AmoAnnotationPanelView extends ItemView {
  plugin: AmoMarkdownAnnotationToolsPlugin;

  constructor(leaf: any, plugin: AmoMarkdownAnnotationToolsPlugin) {
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
      createInfoRow(summary, "Title", info.displayTitle || "-");
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

    const titleSection = root.createDiv({ cls: "amo-panel-section" });
    titleSection.createEl("h4", { text: "Title" });
    const titleEditor = titleSection.createDiv({ cls: "amo-panel-title-editor" });
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.value = info.displayTitle || "";
    titleInput.placeholder = "AMO note title";
    titleEditor.appendChild(titleInput);
    titleInput.disabled = !info.file;
    this.addButton(
      titleEditor,
      "Save title",
      async () => {
        if (!info.file) return;
        await this.plugin.updateAmoNoteTitle(info.file, titleInput.value);
        this.render();
      },
      Boolean(info.file)
    );

    const annotationSection = root.createDiv({ cls: "amo-panel-section" });
    annotationSection.createEl("h4", { text: "Annotations" });
    const annotationItems = info.annotationItems || [];
    if (info.file && annotationItems.length > 0) {
      const list = annotationSection.createDiv({ cls: "amo-panel-annotation-list" });
      for (const item of annotationItems) {
        const row = list.createDiv({ cls: "amo-panel-annotation-row" });
        row.createDiv({
          cls: "amo-panel-annotation-preview",
          text: previewText(item.content || "(empty annotation)", 160),
        });
        this.addButton(
          row,
          "Delete",
          async () => {
            if (!info.file) return;
            await this.plugin.deleteAnnotationFromFile(info.file, item.index);
            this.render();
          },
          true
        );
      }
    } else {
      annotationSection.createDiv({
        cls: "amo-panel-muted",
        text: info.file ? "No annotations found." : "No active Markdown note.",
      });
    }

    const actions = root.createDiv({ cls: "amo-panel-section amo-panel-actions" });
    actions.createEl("h4", { text: "Actions" });
    this.addButton(
      actions,
      "Open note",
      () => {
        if (!info.file) return;
        this.plugin.debugLog("panel.open_note.clicked", {
          notePath: info.file.path,
          source: info.source,
        });
        void this.plugin.openVaultPath(info.file.path, "note");
      },
      Boolean(info.file)
    );
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

  addButton(container: HTMLElement, label: string, onClick: () => void | Promise<void>, enabled: boolean) {
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
