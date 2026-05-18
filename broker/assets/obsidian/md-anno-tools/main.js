const {
  ButtonComponent,
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
const SKIPPED_TAGS = new Set(["A", "BUTTON", "CODE", "INPUT", "PRE", "SCRIPT", "STYLE", "TEXTAREA"]);

class AmoMarkdownAnnotationToolsPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) || {});

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
      name: "Wrap selection with [!anno] tags",
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
  }

  getActiveMarkdownFile() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view ? view.file : null;
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
      new Notice("Copied " + annotations.length + " annotation(s).");
    } catch (error) {
      console.error("Failed to copy annotations:", error);
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
      new Notice(
        "Sent " +
          annotations.length +
          " annotation(s) to AMO" +
          (result.pendingPromptId ? ": " + result.pendingPromptId : ".")
      );
    } catch (error) {
      console.error("Failed to send annotations to AMO:", error);
      new Notice("AMO sync failed: " + messageFromError(error));
    }
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

module.exports = AmoMarkdownAnnotationToolsPlugin;
