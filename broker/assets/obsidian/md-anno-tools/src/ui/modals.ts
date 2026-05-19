import { ButtonComponent, Modal, TextAreaComponent } from "obsidian";
import { canvasTargetDisplayName } from "../canvas/target";

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
