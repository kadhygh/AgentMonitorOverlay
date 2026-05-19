import { ButtonComponent, ItemView } from "obsidian";
import { AMO_PANEL_VIEW_TYPE } from "../core/constants";
import { getWindowSelectionText, messageFromError, createInfoRow, formatNoteTargetSource, formatTime } from "../core/ui-utils";
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
