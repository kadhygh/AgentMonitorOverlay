const {
  ButtonComponent,
  ItemView,
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
const DEFAULT_SETTINGS = {
  bridgeUrl: "http://127.0.0.1:17654",
};
const AMO_PANEL_VIEW_TYPE = "amo-annotation-panel";
const AMO_SEND_ACTION_CLASS = "amo-send-note-action";
const AMO_PANEL_ACTION_CLASS = "amo-open-panel-action";
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

    this.registerView(AMO_PANEL_VIEW_TYPE, (leaf) => new AmoAnnotationPanelView(leaf, this));

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
      name: "Insert or wrap [!anno] annotation",
      editorCallback: (editor) => {
        this.wrapSelectionWithAnnotation(editor);
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

    this.registerMarkdownPostProcessor((el) => {
      this.renderAnnotations(el);
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const hasSelection = editor.getSelection().trim().length > 0;
        menu.addItem((item) => {
          item
            .setTitle(hasSelection ? "Wrap selection with [!anno]" : "Insert [!anno] at cursor")
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
      this.refreshPanels();
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.rememberMarkdownLeaf(leaf);
        this.syncMarkdownViewActions();
        if (!leaf || !leaf.view || typeof leaf.view.getViewType !== "function" || leaf.view.getViewType() !== AMO_PANEL_VIEW_TYPE) {
          this.refreshPanels();
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.rememberCurrentMarkdownView();
        this.syncMarkdownViewActions();
        this.refreshPanels();
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.rememberCurrentMarkdownView();
        this.syncMarkdownViewActions();
        this.refreshPanels();
      })
    );
  }

  onunload() {
    document.querySelectorAll("." + AMO_SEND_ACTION_CLASS + ", ." + AMO_PANEL_ACTION_CLASS).forEach((el) => el.remove());
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
    const view = this.getActiveMarkdownView();
    if (view && view.file) return view.file;

    if (this.lastMarkdownFilePath) {
      const file = this.app.vault.getAbstractFileByPath(this.lastMarkdownFilePath);
      if (file && typeof file.path === "string") return file;
    }

    return null;
  }

  insertAnnotationAtActiveEditor() {
    const view = this.getActiveMarkdownView();
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

  wrapSelectionWithAnnotation(editor) {
    const selection = editor.getSelection();
    if (selection.length > 0) {
      editor.replaceSelection(buildAnnotationMarkup(selection));
      return;
    }

    const cursor = editor.getCursor();
    editor.replaceSelection(ANNO_TAG_PREFIX + ANNO_TAG_SUFFIX);
    editor.setCursor({
      line: cursor.line,
      ch: cursor.ch + ANNO_TAG_PREFIX.length,
    });
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

    const markdown = await this.app.vault.cachedRead(file);
    const block = buildAnnotationMarkup(content);
    const nextContent = markdown.trim().length === 0
      ? block + "\n"
      : markdown.replace(/\s*$/u, "") + "\n\n" + block + "\n";

    await this.app.vault.modify(file, nextContent);
    this.setOperationStatus("Annotation appended to " + file.path + ".", "success");
    new Notice("Annotation appended.");
  }

  async copyAnnotationsFromActiveFile() {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      new Notice("No active Markdown note.");
      return;
    }

    await this.copyAnnotationsFromFile(file);
  }

  async copyAnnotationsFromFile(file) {
    const markdown = await this.app.vault.cachedRead(file);
    const annotations = extractAnnotationContents(markdown);
    if (annotations.length === 0) {
      new Notice("No annotations found in the current note.");
      return;
    }

    try {
      await writeTextToClipboard(formatAnnotationsForClipboard(annotations));
      this.setOperationStatus("Copied " + annotations.length + " annotation(s) from " + file.path + ".", "success");
      new Notice("Copied " + annotations.length + " annotation(s).");
    } catch (error) {
      console.error("Failed to copy annotations:", error);
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
    if (annotations.length === 0) {
      new Notice("No annotations found in the current note.");
      return;
    }

    const amo = parseAmoFrontmatter(markdown);
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
      const result = await postJson(joinUrl(this.settings.bridgeUrl, "/api/obsidian/annotations"), payload);
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
    const file = this.getActiveMarkdownFile();
    if (!file) {
      return {
        file: null,
        annotations: [],
        amo: {},
      };
    }

    const markdown = await this.app.vault.cachedRead(file);
    return {
      file,
      annotations: extractAnnotationContents(markdown),
      amo: parseAmoFrontmatter(markdown),
    };
  }

  renderAnnotations(root) {
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
      createInfoRow(summary, "Session", info.amo.sessionId || "Missing AMO metadata");
      createInfoRow(summary, "Turn", info.amo.turnId || "-");
      createInfoRow(summary, "Annotations", String(info.annotations.length));
    } else {
      summary.createDiv({ cls: "amo-panel-muted", text: "No active Markdown note." });
    }

    const actions = root.createDiv({ cls: "amo-panel-section amo-panel-actions" });
    actions.createEl("h4", { text: "Actions" });
    this.addButton(actions, "Send to AMO", () => this.plugin.sendAnnotationsFromActiveFile(), Boolean(info.file));
    this.addButton(actions, "Copy annotations", () => this.plugin.copyAnnotationsFromActiveFile(), Boolean(info.file));
    this.addButton(actions, "Append annotation", () => {
      if (!info.file) return;
      new AnnotationInputModal(this.app, async (value) => {
        await this.plugin.appendAnnotationToFile(info.file, value);
      }).open();
    }, Boolean(info.file));
    this.addButton(actions, "Insert marker", () => this.plugin.insertAnnotationAtActiveEditor(), Boolean(info.file));
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
  return ANNO_TAG_PREFIX + content + ANNO_TAG_SUFFIX;
}

function extractAnnotationContents(markdown) {
  return Array.from(markdown.matchAll(ANNO_REGEX))
    .map((match) => normalizeAnnotationContent(match[1] || ""))
    .filter((content) => content.length > 0);
}

function normalizeAnnotationContent(value) {
  return String(value || "").replace(/\r\n?/gu, "\n").trim();
}

function formatAnnotationsForClipboard(annotations) {
  return annotations.join("\n\n");
}

function createAnnotationElement(content, isStandalone) {
  const wrapper = document.createElement("span");
  wrapper.classList.add("anno-token");
  if (isStandalone) wrapper.classList.add("anno-token-block");

  const badge = document.createElement("span");
  badge.classList.add("anno-token-badge");
  badge.textContent = "anno";
  wrapper.appendChild(badge);

  const body = document.createElement("span");
  body.classList.add("anno-token-content");
  body.textContent = content || EMPTY_ANNO_TEXT;
  wrapper.appendChild(body);

  return wrapper;
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

async function writeTextToClipboard(value) {
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    throw new Error("Clipboard API is unavailable");
  }
  await navigator.clipboard.writeText(value);
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

function formatTime(value) {
  try {
    return new Date(value).toLocaleTimeString();
  } catch {
    return "";
  }
}

module.exports = AmoMarkdownAnnotationToolsPlugin;
