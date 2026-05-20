import { App, PluginSettingTab, Setting } from "obsidian";
import type { AmoMarkdownAnnotationToolsPlugin } from "../plugin";

export class AmoAnnotationSettingTab extends PluginSettingTab {
  plugin: AmoMarkdownAnnotationToolsPlugin;

  constructor(app: App, plugin: AmoMarkdownAnnotationToolsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("同步内容添加编号")
      .setDesc("发送批注回 CLI session 时，为每条批注添加 1.、2.、3. 前缀。默认关闭。")
      .addToggle((toggle) => {
        toggle
          .setValue(Boolean(this.plugin.settings.numberAnnotationsInPrompt))
          .onChange(async (value) => {
            this.plugin.settings.numberAnnotationsInPrompt = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Canvas 新 note 追加方向")
      .setDesc("控制 AMO 在 AgentFlow.canvas 中创建新 reply/prompt note 的默认位置。默认向下。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("down", "向下")
          .addOption("right", "向右")
          .setValue(this.plugin.settings.canvasAppendDirection === "right" ? "right" : "down")
          .onChange(async (value) => {
            this.plugin.settings.canvasAppendDirection = value === "right" ? "right" : "down";
            await this.plugin.saveSettings();
          });
      });
  }
}
