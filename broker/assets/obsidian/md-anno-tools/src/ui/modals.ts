import { ButtonComponent, Modal, setIcon, TextAreaComponent, TextComponent } from "obsidian";
import { canvasTargetDisplayName } from "../canvas/target";
import type { FavoriteListItem } from "../favorites/actions";

export class AnnotationInputModal extends Modal {
  onSubmit: (value: string) => void | Promise<void>;
  inputComponent: TextAreaComponent;

  constructor(app: any, onSubmit: (value: string) => void | Promise<void>) {
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

export class CanvasNoteTargetModal extends Modal {
  targets: any[];
  actionLabel: string;
  onSelect: (target: any) => void | Promise<void>;

  constructor(app: any, targets: any[], actionLabel: string, onSelect: (target: any) => void | Promise<void>) {
    super(app);
    this.targets = targets;
    this.actionLabel = actionLabel || "Use";
    this.onSelect = onSelect;
  }

  onOpen() {
    this.modalEl.addClass("anno-modal");
    this.titleEl.setText("Choose Canvas Note");
    this.contentEl.createEl("p", {
      text: "AMO could not read the current canvas selection reliably. Choose the note to use.",
    });

    const list = this.contentEl.createDiv({ cls: "amo-canvas-note-list" });
    for (const target of this.targets) {
      const row = list.createDiv({ cls: "amo-canvas-note-row" });
      row.createDiv({
        cls: "amo-canvas-note-name",
        text: canvasTargetDisplayName(target.file.path),
      });
      row.createDiv({
        cls: "amo-canvas-note-path",
        text: target.file.path,
      });
      new ButtonComponent(row)
        .setButtonText(this.actionLabel)
        .setCta()
        .onClick(async () => {
          await this.submit(target);
        });
    }

    const actions = this.contentEl.createDiv({ cls: "anno-modal-actions" });
    new ButtonComponent(actions)
      .setButtonText("Cancel")
      .onClick(() => {
        this.close();
      });
  }

  onClose() {
    this.contentEl.empty();
  }

  async submit(target: any) {
    await this.onSelect(target);
    this.close();
  }
}

export class NoteTitleModal extends Modal {
  currentTitle: string;
  notePath: string;
  onSubmit: (value: string) => void | Promise<void>;
  inputComponent: TextComponent;

  constructor(app: any, currentTitle: string, notePath: string, onSubmit: (value: string) => void | Promise<void>) {
    super(app);
    this.currentTitle = currentTitle || "";
    this.notePath = notePath || "";
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.modalEl.addClass("anno-modal");
    this.titleEl.setText("Edit AMO Title");
    this.contentEl.createEl("p", {
      text: this.notePath
        ? "This changes the rendered AMO title, not the note file name. Leave it empty to hide the AMO title: " + this.notePath
        : "This changes the rendered AMO title, not the note file name. Leave it empty to hide the AMO title.",
    });

    this.inputComponent = new TextComponent(this.contentEl);
    this.inputComponent.setPlaceholder("Display title");
    this.inputComponent.setValue(this.currentTitle);
    this.inputComponent.inputEl.addClass("anno-modal-input");

    const actions = this.contentEl.createDiv({ cls: "anno-modal-actions" });
    new ButtonComponent(actions)
      .setButtonText("Save")
      .setCta()
      .onClick(async () => {
        await this.submit();
      });

    new ButtonComponent(actions)
      .setButtonText("Cancel")
      .onClick(() => {
        this.close();
      });

    this.scope.register([], "Enter", () => {
      void this.submit();
      return false;
    });

    window.setTimeout(() => {
      this.inputComponent.inputEl.focus();
      this.inputComponent.inputEl.select();
    }, 0);
  }

  onClose() {
    this.contentEl.empty();
  }

  async submit() {
    await this.onSubmit(this.inputComponent.getValue());
    this.close();
  }
}

export class WorkCanvasPickerModal extends Modal {
  options: any;
  folderInput: TextComponent | null;
  canvasInput: TextComponent | null;

  constructor(app: any, options: any) {
    super(app);
    this.options = options || {};
    this.folderInput = null;
    this.canvasInput = null;
  }

  onOpen() {
    this.modalEl.addClass("anno-modal");
    this.titleEl.setText("Add Note to Work Canvas");

    const folderPath = this.options.folderPath || "Canvases/work";
    this.contentEl.createEl("p", {
      text: "Choose a work canvas for " + (this.options.notePath || "the current note") + ".",
    });

    if (!this.options.folderExists) {
      this.contentEl.createEl("p", {
        cls: "amo-modal-muted",
        text: "Work canvas folder does not exist yet.",
      });
      const folderRow = this.contentEl.createDiv({ cls: "amo-work-canvas-create-row" });
      this.folderInput = new TextComponent(folderRow);
      this.folderInput.setPlaceholder("work");
      this.folderInput.setValue(folderPath.split("/").pop() || "work");
      new ButtonComponent(folderRow)
        .setButtonText("Create folder")
        .setCta()
        .onClick(async () => {
          await this.options.onCreateFolder?.(this.folderInput?.getValue() || "work");
          this.close();
        });
    } else {
      const canvases = Array.isArray(this.options.canvases) ? this.options.canvases : [];
      if (canvases.length > 0) {
        const list = this.contentEl.createDiv({ cls: "amo-work-canvas-list" });
        for (const canvas of canvases) {
          const row = list.createDiv({
            cls: "amo-work-canvas-row" + (canvas.containsNote ? " contains-note" : ""),
          });
          row.createDiv({
            cls: "amo-work-canvas-name",
            text: canvas.displayName || canvas.path,
          });
          row.createDiv({
            cls: "amo-work-canvas-path",
            text: canvas.path,
          });
          row.createDiv({
            cls: "amo-work-canvas-badge",
            text: canvas.containsNote
              ? "Contains note" + (canvas.occurrenceCount > 1 ? " (" + canvas.occurrenceCount + " copies)" : "")
              : "New target",
          });
          const rowActions = row.createDiv({ cls: "amo-work-canvas-row-actions" });
          if (canvas.containsNote) {
            new ButtonComponent(rowActions)
              .setButtonText("Open")
              .onClick(async () => {
                await this.options.onOpenCanvas?.(canvas.path);
                this.close();
              });
          }
          new ButtonComponent(rowActions)
            .setButtonText(canvas.containsNote ? "Add again" : "Add")
            .setCta()
            .onClick(async () => {
              await this.options.onSelectCanvas?.(canvas.path);
              this.close();
            });
        }
      } else {
        this.contentEl.createEl("p", {
          cls: "amo-modal-muted",
          text: "No work canvas exists in " + folderPath + ". Create one below.",
        });
      }

      const create = this.contentEl.createDiv({ cls: "amo-work-canvas-create" });
      create.createEl("h4", { text: "Create new canvas" });
      const createRow = create.createDiv({ cls: "amo-work-canvas-create-row" });
      this.canvasInput = new TextComponent(createRow);
      this.canvasInput.setPlaceholder("Work canvas name");
      new ButtonComponent(createRow)
        .setButtonText("Create and add")
        .setCta()
        .onClick(async () => {
          await this.options.onCreateCanvas?.(this.canvasInput?.getValue() || "");
          this.close();
        });
    }

    const actions = this.contentEl.createDiv({ cls: "anno-modal-actions" });
    new ButtonComponent(actions)
      .setButtonText("Cancel")
      .onClick(() => {
        this.close();
      });

    window.setTimeout(() => {
      (this.folderInput || this.canvasInput)?.inputEl.focus();
    }, 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class WorkCanvasNavigationModal extends Modal {
  options: any;

  constructor(app: any, options: any) {
    super(app);
    this.options = options || {};
  }

  onOpen() {
    this.modalEl.addClass("anno-modal");
    this.titleEl.setText("Go to Work Canvas");
    this.contentEl.createEl("p", {
      text: this.options.linkedOnly
        ? "This note appears in more than one work canvas. Choose where to go."
        : "This note has no work-canvas link yet. Choose a work canvas to open.",
    });

    const list = this.contentEl.createDiv({ cls: "amo-work-canvas-list" });
    for (const canvas of Array.isArray(this.options.targets) ? this.options.targets : []) {
      const row = list.createDiv({
        cls: "amo-work-canvas-row" + (canvas.containsNote ? " contains-note" : ""),
      });
      row.createDiv({
        cls: "amo-work-canvas-name",
        text: canvas.displayName || canvas.path,
      });
      row.createDiv({
        cls: "amo-work-canvas-path",
        text: canvas.path,
      });
      row.createDiv({
        cls: "amo-work-canvas-badge",
        text: canvas.containsNote
          ? "Contains note" + (canvas.occurrenceCount > 1 ? " (" + canvas.occurrenceCount + " copies)" : "")
          : "No note link",
      });
      const rowActions = row.createDiv({ cls: "amo-work-canvas-row-actions" });
      new ButtonComponent(rowActions)
        .setButtonText("Open")
        .setCta()
        .onClick(async () => {
          await this.options.onSelectCanvas?.(canvas.path);
          this.close();
        });
    }

    const actions = this.contentEl.createDiv({ cls: "anno-modal-actions" });
    new ButtonComponent(actions)
      .setButtonText("Cancel")
      .onClick(() => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class FavoritesModal extends Modal {
  options: any;
  query: string;
  listEl: HTMLElement | null;

  constructor(app: any, options: any) {
    super(app);
    this.options = options || {};
    this.query = "";
    this.listEl = null;
  }

  onOpen() {
    this.modalEl.addClass("anno-modal", "amo-favorites-modal");
    this.titleEl.setText("收藏夹");
    this.contentEl.createEl("p", {
      text: "快速打开已收藏的 Note 或 Canvas。收藏内容保存在当前 Obsidian vault 的 AMO 插件数据中。",
    });

    const search = new TextComponent(this.contentEl);
    search.setPlaceholder("搜索名称、路径或备注");
    search.inputEl.addClass("amo-favorites-search");
    search.onChange((value) => {
      this.query = value.trim().toLowerCase();
      this.renderList();
    });

    this.listEl = this.contentEl.createDiv({ cls: "amo-favorites-list" });
    this.renderList();

    const actions = this.contentEl.createDiv({ cls: "anno-modal-actions" });
    new ButtonComponent(actions).setButtonText("关闭").onClick(() => this.close());
    window.setTimeout(() => search.inputEl.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
    this.listEl = null;
  }

  renderList() {
    if (!this.listEl) return;
    this.listEl.empty();
    const allItems: FavoriteListItem[] = this.options.getItems?.() || [];
    const items = allItems.filter((item) => {
      if (!this.query) return true;
      return (
        item.displayName.toLowerCase().includes(this.query) ||
        item.path.toLowerCase().includes(this.query) ||
        item.remark.toLowerCase().includes(this.query)
      );
    });

    if (items.length === 0) {
      this.listEl.createDiv({
        cls: "amo-favorites-empty",
        text: allItems.length === 0 ? "还没有收藏任何 Note 或 Canvas。" : "没有匹配的收藏内容。",
      });
      return;
    }

    for (const item of items) this.renderItem(item);
  }

  renderItem(item: FavoriteListItem) {
    if (!this.listEl) return;
    const row = this.listEl.createDiv({ cls: "amo-favorite-row" + (item.exists ? "" : " is-missing") });
    const openButton = row.createEl("button", {
      cls: "amo-favorite-open",
      attr: {
        type: "button",
        title: item.exists ? "打开 " + item.path : "文件已不存在：" + item.path,
        "aria-label": item.exists ? "打开 " + item.path : "文件已不存在：" + item.path,
      },
    }) as HTMLButtonElement;
    openButton.disabled = !item.exists;
    setIcon(openButton.createSpan({ cls: "amo-favorite-icon" }), item.kind === "canvas" ? "layout-dashboard" : "file-text");
    const text = openButton.createSpan({ cls: "amo-favorite-text" });
    text.createSpan({ cls: "amo-favorite-name", text: item.displayName });
    text.createSpan({ cls: "amo-favorite-path", text: item.path });
    if (item.remark) {
      text.createSpan({
        cls: "amo-favorite-remark",
        text: item.remark,
        attr: { title: item.remark },
      });
    }
    openButton.createSpan({
      cls: "amo-favorite-kind",
      text: item.exists ? (item.kind === "canvas" ? "Canvas" : "Note") : "已失效",
    });
    openButton.addEventListener("click", async () => {
      if (!item.exists) return;
      const opened = await this.options.onOpen?.(item);
      if (opened !== false) this.close();
    });

    const removeButton = row.createEl("button", {
      cls: "amo-favorite-remove",
      attr: {
        type: "button",
        title: "从收藏夹移除",
        "aria-label": "从收藏夹移除 " + item.displayName,
      },
    }) as HTMLButtonElement;
    setIcon(removeButton, "trash-2");
    removeButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await this.options.onRemove?.(item.path);
      this.renderList();
    });
  }
}
