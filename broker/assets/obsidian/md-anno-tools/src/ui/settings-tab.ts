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

    containerEl.createEl("h3", { text: "快捷键" });

    new Setting(containerEl)
      .setName("启用上下文鼠标快捷键")
      .setDesc("在 Markdown 编辑器中插入批注；在笔记其他区域返回批注。键盘快捷键请在 Obsidian 的快捷键页面绑定 AMO Commands。")
      .addToggle((toggle) => {
        toggle
          .setValue(Boolean(this.plugin.settings.contextMouseShortcutEnabled))
          .onChange(async (value) => {
            this.plugin.settings.contextMouseShortcutEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("鼠标侧键")
      .setDesc("选择用于 AMO 上下文操作的鼠标侧键。")
      .setDisabled(!this.plugin.settings.contextMouseShortcutEnabled)
      .addDropdown((dropdown) => {
        dropdown
          .addOption("mouse4", "Mouse4")
          .addOption("mouse5", "Mouse5")
          .setValue(this.plugin.settings.contextMouseShortcutButton === "mouse4" ? "mouse4" : "mouse5")
          .onChange(async (value) => {
            this.plugin.settings.contextMouseShortcutButton = value === "mouse4" ? "mouse4" : "mouse5";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("需要 Ctrl")
      .setDesc("关闭后只按鼠标侧键即可触发。为了减少与浏览器前进/后退冲突，建议保持开启。")
      .setDisabled(!this.plugin.settings.contextMouseShortcutEnabled)
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.contextMouseShortcutRequireCtrl !== false)
          .onChange(async (value) => {
            this.plugin.settings.contextMouseShortcutRequireCtrl = value;
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "内容与显示" });

    new Setting(containerEl)
      .setName("CLI 安全复制")
      .setDesc("复制或返回批注时，将换行替换为空格，避免终端 CLI 在粘贴时提前提交。默认开启。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.safeCliPaste !== false)
          .onChange(async (value) => {
            this.plugin.settings.safeCliPaste = value;
            await this.plugin.saveSettings();
          });
      });

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
      .setName("隐藏 AMO note 属性")
      .setDesc("默认隐藏 AMO 生成 note 顶部的 properties。只作用于 Markdown note，不作用于 Canvas 节点。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.hideAmoNoteProperties !== false)
          .onChange(async (value) => {
            this.plugin.settings.hideAmoNoteProperties = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Canvas 新 note 追加方向")
      .setDesc("控制 AMO 在 AgentFlow.base.canvas 中创建新 reply/prompt note 的默认位置。默认向下。")
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

    new Setting(containerEl)
      .setName("接管本地代码链接跳转")
      .setDesc("拦截 G:/path/file.cs:286 这类链接，避免 Windows 把行号当作文件名。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.interceptLocalCodeLinks !== false)
          .onChange(async (value) => {
            this.plugin.settings.interceptLocalCodeLinks = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("代码链接打开方式")
      .setDesc("VS Code 使用 URL 协议；Zed 使用官方 CLI 方式打开到指定行。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("vscode", "VS Code")
          .addOption("zed", "Zed")
          .addOption("custom-url", "自定义 URL")
          .setValue(this.plugin.settings.localCodeLinkEditor === "zed" || this.plugin.settings.localCodeLinkEditor === "custom-url" ? this.plugin.settings.localCodeLinkEditor : "vscode")
          .onChange(async (value) => {
            this.plugin.settings.localCodeLinkEditor = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("代码链接打开模板")
      .setDesc("用于 VS Code 或自定义 URL。支持 {path}、{rawPath}、{line}、{column}。")
      .addText((text) => {
        text
          .setPlaceholder("vscode://file/{path}:{line}")
          .setValue(String(this.plugin.settings.localCodeLinkUrlTemplate || ""))
          .onChange(async (value) => {
            this.plugin.settings.localCodeLinkUrlTemplate = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Zed CLI 命令")
      .setDesc("选择 Zed 打开方式时使用。默认 zed；如果 PATH 未配置，可填完整 zed.exe 路径。")
      .addText((text) => {
        text
          .setPlaceholder("zed")
          .setValue(String(this.plugin.settings.zedCommand || "zed"))
          .onChange(async (value) => {
            this.plugin.settings.zedCommand = value.trim() || "zed";
            await this.plugin.saveSettings();
          });
      });
  }
}
