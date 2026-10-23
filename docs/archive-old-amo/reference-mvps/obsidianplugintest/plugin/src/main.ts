import {
	App,
	ButtonComponent,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	TFile,
	TextAreaComponent,
} from 'obsidian';

const ANNO_REGEX = /\[!anno\]([\s\S]*?)\[\/anno\]/gi;
const ANNO_HEADER_ACTION_CLASS = 'anno-copy-view-action';
const ANNO_BUTTON_TITLE = '复制当前笔记中的批注到剪切板';
const EMPTY_ANNO_TEXT = '（空批注）';
const ANNO_TAG_PREFIX = '[!anno]';
const ANNO_TAG_SUFFIX = '[/anno]';
const SKIPPED_TAGS = new Set(['A', 'BUTTON', 'CODE', 'INPUT', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA']);

export default class MarkdownAnnotationToolsPlugin extends Plugin {
	async onload() {
		this.addRibbonIcon('clipboard-copy', ANNO_BUTTON_TITLE, () => {
			void this.copyAnnotationsFromActiveFile();
		});

		this.addCommand({
			id: 'copy-annotations-from-current-note',
			name: '复制当前笔记中的批注到剪切板',
			checkCallback: (checking: boolean) => {
				const file = this.getActiveMarkdownFile();
				if (!file) {
					return false;
				}

				if (!checking) {
					void this.copyAnnotationsFromFile(file);
				}
				return true;
			},
		});

		this.addCommand({
			id: 'wrap-selection-with-annotation-tag',
			name: '用 [!anno]...[/anno] 包裹当前选中内容',
			editorCallback: (editor: Editor) => {
				this.wrapSelectionWithAnnotation(editor);
			},
		});

		this.addCommand({
			id: 'append-annotation-to-current-note',
			name: '向当前笔记末尾追加批注',
			checkCallback: (checking: boolean) => {
				const file = this.getActiveMarkdownFile();
				if (!file) {
					return false;
				}

				if (!checking) {
					new AnnotationInputModal(this.app, async (value: string) => {
						await this.appendAnnotationToFile(file, value);
					}).open();
				}
				return true;
			},
		});

		this.registerMarkdownPostProcessor((el: HTMLElement) => {
			this.renderAnnotations(el);
		});

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor) => {
				const selection = editor.getSelection();
				if (!selection || selection.trim().length === 0) {
					return;
				}

				menu.addItem((item) => {
					item
						.setTitle('为当前选中文本添加批注')
						.setIcon('message-square-plus')
						.onClick(() => {
							this.wrapSelectionWithAnnotation(editor);
						});
				});
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			this.syncMarkdownViewActions();
		});

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.syncMarkdownViewActions();
			}),
		);

		this.registerEvent(
			this.app.workspace.on('file-open', () => {
				this.syncMarkdownViewActions();
			}),
		);

		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.syncMarkdownViewActions();
			}),
		);
	}

	onunload() {
		document.querySelectorAll(`.${ANNO_HEADER_ACTION_CLASS}`).forEach((el) => el.remove());
	}

	private syncMarkdownViewActions(): void {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			if (!(leaf.view instanceof MarkdownView)) {
				continue;
			}

			const view = leaf.view;
			if (view.containerEl.querySelector(`.${ANNO_HEADER_ACTION_CLASS}`)) {
				continue;
			}

			const actionEl = view.addAction('clipboard-copy', ANNO_BUTTON_TITLE, () => {
				const file = view.file;
				if (!file) {
					new Notice('当前没有打开 Markdown 笔记');
					return;
				}
				void this.copyAnnotationsFromFile(file);
			});

			actionEl.addClass(ANNO_HEADER_ACTION_CLASS);
		}
	}

	private wrapSelectionWithAnnotation(editor: Editor): void {
		const selection = editor.getSelection();
		if (selection.length > 0) {
			editor.replaceSelection(buildAnnotationMarkup(selection));
			return;
		}

		const cursor = editor.getCursor();
		editor.replaceSelection(`${ANNO_TAG_PREFIX}${ANNO_TAG_SUFFIX}`);
		editor.setCursor({
			line: cursor.line,
			ch: cursor.ch + ANNO_TAG_PREFIX.length,
		});
	}

	private renderAnnotations(root: HTMLElement): void {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: (node: Node) => {
				if (!(node instanceof Text)) {
					return NodeFilter.FILTER_REJECT;
				}

				if (!this.shouldProcessTextNode(node)) {
					return NodeFilter.FILTER_REJECT;
				}

				return NodeFilter.FILTER_ACCEPT;
			},
		});

		const targets: Text[] = [];
		while (walker.nextNode()) {
			targets.push(walker.currentNode as Text);
		}

		for (const textNode of targets) {
			this.replaceAnnotationsInTextNode(textNode);
		}
	}

	private shouldProcessTextNode(textNode: Text): boolean {
		const text = textNode.nodeValue ?? '';
		if (!text.includes(ANNO_TAG_PREFIX) || !text.includes(ANNO_TAG_SUFFIX)) {
			return false;
		}

		const parent = textNode.parentElement;
		if (!parent || parent.closest('.anno-token')) {
			return false;
		}

		for (let current: HTMLElement | null = parent; current; current = current.parentElement) {
			if (SKIPPED_TAGS.has(current.tagName)) {
				return false;
			}
		}

		return true;
	}

	private replaceAnnotationsInTextNode(textNode: Text): void {
		const source = textNode.nodeValue ?? '';
		const matches = Array.from(source.matchAll(ANNO_REGEX));
		if (matches.length === 0) {
			return;
		}

		const fragment = document.createDocumentFragment();
		let currentIndex = 0;
		const firstMatch = matches[0];
		const isStandalone = matches.length === 1 && !!firstMatch && source.trim() === firstMatch[0].trim();

		for (const match of matches) {
			const fullMatch = match[0];
			const content = normalizeAnnotationContent(match[1] ?? '');
			const matchIndex = match.index ?? 0;

			if (matchIndex > currentIndex) {
				fragment.append(source.slice(currentIndex, matchIndex));
			}

			fragment.append(this.createAnnotationElement(content, isStandalone));
			currentIndex = matchIndex + fullMatch.length;
		}

		if (currentIndex < source.length) {
			fragment.append(source.slice(currentIndex));
		}

		textNode.replaceWith(fragment);
	}

	private createAnnotationElement(content: string, isStandalone: boolean): HTMLElement {
		const wrapper = document.createElement('span');
		wrapper.classList.add('anno-token');
		if (isStandalone) {
			wrapper.classList.add('anno-token-block');
		}

		const badge = document.createElement('span');
		badge.classList.add('anno-token-badge');
		badge.textContent = '批注';
		wrapper.appendChild(badge);

		const body = document.createElement('span');
		body.classList.add('anno-token-content');
		body.textContent = content || EMPTY_ANNO_TEXT;
		wrapper.appendChild(body);

		return wrapper;
	}

	private getActiveMarkdownFile(): TFile | null {
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
	}

	private async copyAnnotationsFromActiveFile(): Promise<void> {
		const file = this.getActiveMarkdownFile();
		if (!file) {
			new Notice('当前没有打开 Markdown 笔记');
			return;
		}

		await this.copyAnnotationsFromFile(file);
	}

	private async copyAnnotationsFromFile(file: TFile): Promise<void> {
		const markdown = await this.app.vault.cachedRead(file);
		const annotations = extractAnnotationContents(markdown);
		if (annotations.length === 0) {
			new Notice('当前笔记没有找到可复制的批注');
			return;
		}

		try {
			await writeTextToClipboard(formatAnnotationsForClipboard(annotations));
			new Notice(`已复制 ${annotations.length} 条批注到剪切板`);
		} catch (error) {
			console.error('Failed to copy annotations:', error);
			new Notice('复制失败，请稍后重试');
		}
	}

	private async appendAnnotationToFile(file: TFile, rawContent: string): Promise<void> {
		const content = normalizeAnnotationContent(rawContent);
		if (!content) {
			new Notice('批注内容不能为空');
			return;
		}

		if (content.includes(ANNO_TAG_SUFFIX)) {
			new Notice(`批注内容不能包含 ${ANNO_TAG_SUFFIX}`);
			return;
		}

		const markdown = await this.app.vault.cachedRead(file);
		const block = buildAnnotationMarkup(content);
		const nextContent = markdown.trim().length === 0
			? `${block}\n`
			: `${markdown.replace(/\s*$/u, '')}\n\n${block}\n`;

		await this.app.vault.modify(file, nextContent);
		new Notice('批注已追加到当前笔记末尾');
	}
}

class AnnotationInputModal extends Modal {
	private readonly onSubmit: (value: string) => Promise<void>;
	private inputComponent!: TextAreaComponent;

	constructor(app: App, onSubmit: (value: string) => Promise<void>) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		this.modalEl.addClass('anno-modal');
		this.titleEl.setText('追加批注');

		const description = this.contentEl.createEl('p');
		description.setText('将批注内容追加到当前笔记末尾，并使用 [!anno]...[/anno] 语法写回原文。');

		this.inputComponent = new TextAreaComponent(this.contentEl);
		this.inputComponent.setPlaceholder('输入批注内容');
		this.inputComponent.inputEl.addClass('anno-modal-input');
		this.inputComponent.inputEl.rows = 6;

		const actions = this.contentEl.createDiv({ cls: 'anno-modal-actions' });

		const confirmButton = new ButtonComponent(actions);
		confirmButton
			.setButtonText('追加批注')
			.setCta()
			.onClick(async () => {
				await this.submit();
			});

		new ButtonComponent(actions)
			.setButtonText('取消')
			.onClick(() => {
				this.close();
			});

		this.scope.register([], 'Enter', (event: KeyboardEvent) => {
			if (!event.ctrlKey && !event.metaKey) {
				return true;
			}

			void this.submit();
			return false;
		});

		window.setTimeout(() => this.inputComponent.inputEl.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
	}

	private async submit(): Promise<void> {
		await this.onSubmit(this.inputComponent.getValue());
		this.close();
	}
}

function buildAnnotationMarkup(content: string): string {
	return `${ANNO_TAG_PREFIX}${content}${ANNO_TAG_SUFFIX}`;
}

function extractAnnotationContents(markdown: string): string[] {
	return Array.from(markdown.matchAll(ANNO_REGEX))
		.map((match) => normalizeAnnotationContent(match[1] ?? ''))
		.filter((content) => content.length > 0);
}

function normalizeAnnotationContent(value: string): string {
	return value.replace(/\r\n?/gu, '\n').trim();
}

function formatAnnotationsForClipboard(annotations: string[]): string {
	return annotations.join('\n\n');
}

async function writeTextToClipboard(value: string): Promise<void> {
	if (!navigator.clipboard?.writeText) {
		throw new Error('Clipboard API is unavailable');
	}

	await navigator.clipboard.writeText(value);
}
