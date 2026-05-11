import {
  Notice,
  Plugin,
  TFile,
  normalizePath,
  type ObsidianProtocolData,
} from "obsidian";

const INBOX_DIR = ".amo/inbox";
const PROCESSED_DIR = ".amo/inbox/processed";
const OUTBOX_DIR = ".amo/outbox";
const NOTE_ROOT = "AMO/Sessions";

interface AmoWindowHint {
  title?: string;
  process?: string;
  pid?: number | null;
  hwnd?: number | null;
}

interface AmoSessionPayload {
  sessionId: string;
  tool: string;
  cwd: string;
  project: string;
  title: string;
  state: string;
  lastEvent?: string;
  lastMessage?: string;
  updatedAt?: string;
  windowHint?: AmoWindowHint;
}

interface AmoCreateLinkedNoteRequest {
  schemaVersion: 1;
  action: "create-linked-note";
  requestId: string;
  requestedAt: string;
  source: "agent-monitor-overlay";
  session: AmoSessionPayload;
}

interface AmoCreateLinkedNoteResult {
  schemaVersion: 1;
  action: "create-linked-note-result";
  requestId: string;
  ok: boolean;
  handledAt: string;
  notePath?: string;
  message: string;
}

export default class AgentMonitorOverlayPlugin extends Plugin {
  async onload() {
    this.addCommand({
      id: "create-demo-linked-note",
      name: "Create/open demo linked note",
      callback: () => this.handleRequest(makeDemoRequest()),
    });

    this.addCommand({
      id: "process-pending-linked-note-requests",
      name: "Process pending linked note requests",
      callback: () => this.processPendingRequests(),
    });

    this.registerObsidianProtocolHandler("amo-create-note", (params) => {
      void this.handleProtocolRequest(params);
    });

    await this.ensureRuntimeDirs();
    this.app.workspace.onLayoutReady(() => {
      void this.processPendingRequests();
    });
    this.registerInterval(window.setInterval(() => void this.processPendingRequests(), 1500));
    await this.processPendingRequests();
    new Notice("AMO plugin loaded");
  }

  async onunload() {
    new Notice("AMO plugin unloaded");
  }

  private async handleProtocolRequest(params: ObsidianProtocolData) {
    const requestId = firstParam(params.requestId);
    if (requestId) {
      await this.processRequestFile(`${INBOX_DIR}/create-linked-note-${requestId}.json`);
      return;
    }

    const payload = firstParam(params.payload);
    if (payload) {
      try {
        const request = JSON.parse(decodeURIComponent(payload)) as AmoCreateLinkedNoteRequest;
        await this.handleRequest(request);
      } catch (error) {
        new Notice(`AMO request payload failed: ${(error as Error).message}`);
      }
      return;
    }

    await this.processPendingRequests();
  }

  private async processPendingRequests() {
    await this.ensureRuntimeDirs();

    let files: string[];
    try {
      files = await this.app.vault.adapter.list(INBOX_DIR).then((listing) => listing.files);
    } catch {
      return;
    }

    const pending = files
      .filter((path) => path.endsWith(".json") && path.includes("create-linked-note-"))
      .sort();

    for (const path of pending) {
      await this.processRequestFile(path);
    }
  }

  private async processRequestFile(path: string) {
    try {
      const raw = await this.app.vault.adapter.read(path);
      const request = JSON.parse(raw) as AmoCreateLinkedNoteRequest;
      await this.handleRequest(request, path);
    } catch (error) {
      new Notice(`AMO request failed: ${(error as Error).message}`);
    }
  }

  private async handleRequest(request: AmoCreateLinkedNoteRequest, inboxPath?: string) {
    try {
      validateRequest(request);
      const notePath = await this.createOrOpenLinkedNote(request);
      await this.writeResult({
        schemaVersion: 1,
        action: "create-linked-note-result",
        requestId: request.requestId,
        ok: true,
        handledAt: new Date().toISOString(),
        notePath,
        message: "Linked note created or opened.",
      });

      if (inboxPath) {
        await this.archiveRequest(inboxPath);
      }

      new Notice(`AMO linked note: ${notePath}`);
    } catch (error) {
      const message = (error as Error).message;
      await this.writeResult({
        schemaVersion: 1,
        action: "create-linked-note-result",
        requestId: request.requestId ?? "unknown",
        ok: false,
        handledAt: new Date().toISOString(),
        message,
      });
      new Notice(`AMO linked note failed: ${message}`);
    }
  }

  private async createOrOpenLinkedNote(request: AmoCreateLinkedNoteRequest) {
    const notePath = notePathForSession(request.session);
    await this.ensureFolder(parentPath(notePath));

    let file = this.app.vault.getAbstractFileByPath(notePath);
    if (!file) {
      file = await this.app.vault.create(notePath, renderLinkedNote(request, notePath));
    }

    if (!(file instanceof TFile)) {
      throw new Error(`Target path is not a Markdown file: ${notePath}`);
    }

    await this.app.workspace.getLeaf(false).openFile(file);
    return notePath;
  }

  private async ensureRuntimeDirs() {
    await this.ensureFolder(INBOX_DIR);
    await this.ensureFolder(PROCESSED_DIR);
    await this.ensureFolder(OUTBOX_DIR);
    await this.ensureFolder(NOTE_ROOT);
  }

  private async ensureFolder(path: string) {
    const normalized = normalizePath(path);
    if (!normalized || normalized === "/") {
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

  private async writeResult(result: AmoCreateLinkedNoteResult) {
    await this.ensureFolder(OUTBOX_DIR);
    const path = `${OUTBOX_DIR}/create-linked-note-${safeFileSegment(result.requestId)}.json`;
    await this.app.vault.adapter.write(path, `${JSON.stringify(result, null, 2)}\n`);
  }

  private async archiveRequest(inboxPath: string) {
    await this.ensureFolder(PROCESSED_DIR);
    const fileName = inboxPath.split("/").pop() ?? `request-${Date.now()}.json`;
    const target = `${PROCESSED_DIR}/${fileName}`;
    try {
      await this.app.vault.adapter.rename(inboxPath, target);
    } catch {
      await this.app.vault.adapter.remove(inboxPath);
    }
  }
}

function makeDemoRequest(): AmoCreateLinkedNoteRequest {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    action: "create-linked-note",
    requestId: `demo-${Date.now()}`,
    requestedAt: now,
    source: "agent-monitor-overlay",
    session: {
      sessionId: "demo-session",
      tool: "codex",
      cwd: "D:/Projects/commonproject/AgentMonitorOverlay",
      project: "AgentMonitorOverlay",
      title: "Codex - AgentMonitorOverlay",
      state: "running",
      lastEvent: "manual-command",
      lastMessage: "Created from Obsidian command palette.",
      updatedAt: now,
      windowHint: {
        title: "Codex - AgentMonitorOverlay",
        process: "WindowsTerminal.exe",
      },
    },
  };
}

function validateRequest(request: AmoCreateLinkedNoteRequest) {
  if (request.schemaVersion !== 1) {
    throw new Error("Unsupported request schemaVersion.");
  }
  if (request.action !== "create-linked-note") {
    throw new Error(`Unsupported action: ${request.action}`);
  }
  if (!request.requestId?.trim()) {
    throw new Error("Missing requestId.");
  }
  if (!request.session?.sessionId?.trim()) {
    throw new Error("Missing session.sessionId.");
  }
  if (!request.session?.tool?.trim()) {
    throw new Error("Missing session.tool.");
  }
}

function notePathForSession(session: AmoSessionPayload) {
  const project = safeFileSegment(session.project || basename(session.cwd) || "unknown-project");
  const tool = safeFileSegment(session.tool || "agent");
  const sessionId = safeFileSegment(session.sessionId);
  return normalizePath(`${NOTE_ROOT}/${project}/${tool}-${sessionId}.md`);
}

function renderLinkedNote(request: AmoCreateLinkedNoteRequest, notePath: string) {
  const session = request.session;
  const windowHint = session.windowHint ?? {};
  return `---\n${[
    "amo:",
    "  schemaVersion: 1",
    '  source: "agent-monitor-overlay"',
    `  notePath: ${yamlString(notePath)}`,
    `  sessionId: ${yamlString(session.sessionId)}`,
    `  tool: ${yamlString(session.tool)}`,
    `  cwd: ${yamlString(session.cwd)}`,
    `  project: ${yamlString(session.project)}`,
    `  title: ${yamlString(session.title)}`,
    `  state: ${yamlString(session.state)}`,
    `  lastEvent: ${yamlString(session.lastEvent ?? "")}`,
    `  lastMessage: ${yamlString(session.lastMessage ?? "")}`,
    `  requestedAt: ${yamlString(request.requestedAt)}`,
    `  createdAt: ${yamlString(new Date().toISOString())}`,
    "  windowHint:",
    `    title: ${yamlString(windowHint.title ?? "")}`,
    `    process: ${yamlString(windowHint.process ?? "")}`,
    `    pid: ${yamlScalar(windowHint.pid)}`,
    `    hwnd: ${yamlScalar(windowHint.hwnd)}`,
  ].join("\n")}\n---\n\n# ${session.title || session.sessionId}\n\nLinked from Agent Monitor Overlay.\n\n## Session\n\n- Tool: ${session.tool}\n- Session: \`${session.sessionId}\`\n- Project: ${session.project || basename(session.cwd) || "unknown"}\n- CWD: \`${session.cwd || ""}\`\n- State: ${session.state}\n\n## Notes\n\nAdd review notes or annotations here. Structured annotations will be handled by a later plugin command.\n`;
}

function parentPath(path: string) {
  return path.split("/").slice(0, -1).join("/");
}

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function safeFileSegment(value: string) {
  const cleaned = value
    .trim()
    .replace(/[:*?"<>|#^[\]]/g, "-")
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "unknown";
}

function yamlString(value: string) {
  return JSON.stringify(value ?? "");
}

function yamlScalar(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "null";
}

function firstParam(value: unknown) {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined;
  }
  return typeof value === "string" ? value : undefined;
}
