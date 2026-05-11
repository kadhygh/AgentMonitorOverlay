"use strict";

const { Plugin, Notice, MarkdownView, TFile, normalizePath } = require("obsidian");
const path = require("path");
const { execFile } = require("child_process");
const { clipboard } = require("electron");
const core = require("./syncBackCore");

const DEFAULT_SETTINGS = {
  helperScriptPath: "",
  previewRoot: "AMO/SyncBackPreviews",
  requestOutboxRoot: ".amo/sync-back/outbox",
  defaultVaultName: "obsidian-sync-back-vault",
  powershellPath: "powershell.exe",
};

module.exports = class AmoSyncBackTestPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) || {});

    this.addCommand({
      id: "insert-annotation-block",
      name: "AMO: Insert Annotation Block",
      editorCallback: (editor) => this.insertAnnotationBlock(editor),
    });

    this.addCommand({
      id: "summarize-active-note-annotations",
      name: "AMO: Summarize Active Note Annotations",
      callback: () => void this.summarizeActiveNoteAnnotations({ copyToClipboard: false, focusTarget: false }),
    });

    this.addCommand({
      id: "copy-summary-and-focus-target-session",
      name: "AMO: Copy Summary and Focus Target Session",
      callback: () => void this.summarizeActiveNoteAnnotations({ copyToClipboard: true, focusTarget: true }),
    });

    new Notice("AMO sync-back test plugin loaded");
  }

  insertAnnotationBlock(editor) {
    const selected = editor.getSelection();
    const block = core.createAnnotationBlock({
      body: selected && selected.trim() ? selected.trim() : "Fill in annotation text here.",
    });
    editor.replaceSelection(block);
    new Notice("AMO annotation block inserted");
  }

  async summarizeActiveNoteAnnotations(options) {
    const context = this.getActiveMarkdownContext();
    if (!context) {
      new Notice("Open a Markdown note first.");
      return null;
    }

    const { file, view } = context;
    const content = view.editor.getValue();
    const binding = this.getBindingFromFrontmatter(file);
    const annotations = core.extractAnnotations(content);
    const previewPath = core.defaultPreviewPath(file.path, this.settings.previewRoot);
    const summary = core.buildSummary({
      generatedAt: new Date().toISOString(),
      sourceNotePath: file.path,
      previewNotePath: previewPath,
      binding,
      annotations,
    });

    await this.writeVaultFile(previewPath, summary);
    await this.openVaultFile(previewPath);
    new Notice(`AMO summary generated with ${annotations.length} annotations.`);

    if (options.copyToClipboard) {
      clipboard.writeText(summary);
      new Notice("AMO summary copied to clipboard.");
    }

    let helperResult = null;
    if (options.focusTarget) {
      const request = core.buildSyncBackRequest({
        generatedAt: new Date().toISOString(),
        vaultName: this.settings.defaultVaultName,
        sourceNotePath: file.path,
        previewNotePath: previewPath,
        binding,
        annotations,
        summary,
      });
      const requestPath = normalizePath(
        `${this.settings.requestOutboxRoot}/${request.requestId}.json`
      );
      await this.writeVaultFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
      helperResult = await this.invokeHelper(requestPath);
      if (helperResult.ok) {
        new Notice(`AMO helper resolved target via ${helperResult.stage}. Manual paste/send is still required.`);
      } else {
        const reason = helperResult.error || helperResult.message || "unknown_error";
        new Notice(`AMO helper could not focus target: ${reason}`);
      }
    }

    return {
      filePath: file.path,
      binding,
      annotations,
      summary,
      previewPath,
      helperResult,
    };
  }

  getActiveMarkdownContext() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !(view.file instanceof TFile)) {
      return null;
    }
    return { view, file: view.file };
  }

  getBindingFromFrontmatter(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    const amo = cache && cache.frontmatter ? cache.frontmatter.amo : null;
    if (!amo || typeof amo !== "object") {
      throw new Error("Missing frontmatter 'amo' binding.");
    }

    if (!amo.targetSessionId || !amo.expectedTool) {
      throw new Error("Frontmatter 'amo' must include targetSessionId and expectedTool.");
    }

    return {
      targetSessionId: `${amo.targetSessionId}`,
      expectedTool: `${amo.expectedTool}`,
      cwd: amo.cwd ? `${amo.cwd}` : null,
      project: amo.project ? `${amo.project}` : null,
      windowHint: normalizeWindowHint(amo.windowHint),
    };
  }

  async writeVaultFile(vaultPath, contents) {
    const normalized = normalizePath(vaultPath);
    await this.ensureVaultFolder(parentPath(normalized));
    const existing = this.app.vault.getAbstractFileByPath(normalized);

    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, contents);
      return existing;
    }

    return this.app.vault.create(normalized, contents);
  }

  async openVaultFile(vaultPath) {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(vaultPath));
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  async ensureVaultFolder(vaultPath) {
    const normalized = normalizePath(vaultPath || "");
    if (!normalized) {
      return;
    }

    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  async invokeHelper(vaultRequestPath) {
    if (!this.settings.helperScriptPath) {
      return {
        ok: false,
        error: "missing_helper_script",
        message: "helperScriptPath is not configured in plugin data.json",
      };
    }

    const vaultRoot = this.app.vault.adapter.basePath;
    const requestPath = path.join(vaultRoot, vaultRequestPath.replace(/\//g, path.sep));

    return new Promise((resolve) => {
      execFile(
        this.settings.powershellPath,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          this.settings.helperScriptPath,
          "-RequestPath",
          requestPath,
        ],
        { windowsHide: true },
        (error, stdout, stderr) => {
          const payload = tryParseHelperJson(stdout) || tryParseHelperJson(stderr) || {};
          if (error) {
            resolve(
              Object.assign(
                {
                  ok: false,
                  error: payload.error || error.message,
                  message: stderr || stdout || error.message,
                },
                payload
              )
            );
            return;
          }
          resolve(
            Object.assign(
              {
                ok: true,
                message: "helper completed",
              },
              payload
            )
          );
        }
      );
    });
  }
};

function parentPath(value) {
  return `${value || ""}`.split("/").slice(0, -1).join("/");
}

function normalizeWindowHint(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const titleContains = Array.isArray(value.titleContains)
    ? value.titleContains.map((item) => `${item}`).filter(Boolean)
    : [];

  return {
    titleToken: value.titleToken ? `${value.titleToken}` : null,
    process: value.process ? `${value.process}` : null,
    titleContains,
    pid: Number.isSafeInteger(value.pid) ? value.pid : null,
    hwnd: Number.isSafeInteger(value.hwnd) ? value.hwnd : null,
  };
}

function tryParseHelperJson(text) {
  if (!text || typeof text !== "string") {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
