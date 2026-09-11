import type { AgentSession } from "../types";
import type { Card } from "../api/cardClient";

export const FOCUS_COMMAND_ACTIONS = ["activate", "resume", "openNote", "openCanvas", "openVSCode", "markReviewed", "unbindWindow", "archive", "dismiss", "openApp", "handleAttention", "openLaunchPanel", "openWorkspacePanel", "bindInMain"] as const;
export type FocusCommandAction = typeof FOCUS_COMMAND_ACTIONS[number];
export const FOCUS_CONVERSATION_ACTIONS: readonly FocusCommandAction[] = ["activate", "resume", "openApp", "unbindWindow", "handleAttention", "bindInMain"];
export type FocusAdditionalCommands = Partial<Record<Exclude<FocusCommandAction, "activate" | "resume">, (session: AgentSession) => void | Promise<void>>>;

export interface FocusSessionCommand {
  requestId: string;
  action: FocusCommandAction;
  sessionId: string;
  frameworkId: string;
  cardId: string;
  sessionComponentId: string;
  conversationComponentId: string | null;
}
export interface FocusCommandResult { requestId: string; ok: boolean; message: string }
interface FocusCommandPorts {
  loadSession(id: string): Promise<AgentSession>;
  loadCard(id: string): Promise<Card>;
  revealMain(): Promise<void>;
  activate(session: AgentSession): Promise<void>;
  resume(session: AgentSession): Promise<void>;
  commands?: FocusAdditionalCommands;
}
export function focusFrameworkId(tool: string): string {
  const normalized = tool.trim().toLowerCase();
  if (["codex", "codex-cli", "codex-app", "openai-codex", "openai codex"].includes(normalized)) return "codex";
  if (["claude", "claude-cli", "claude-code", "claude_code", "claude code"].includes(normalized)) return "claude";
  if (["grok", "grok-build", "grok-cli", "grok-code"].includes(normalized)) return "grok";
  return "unknown";
}

// Share the main window's command owner. Never acknowledge human review here.
export function createFocusCommandRouter(ports: FocusCommandPorts) {
  const requests = new Map<string, { fingerprint: string; result: Promise<FocusCommandResult>; complete: boolean }>();
  const activeSessions = new Set<string>();
  return async (input: unknown): Promise<FocusCommandResult> => {
    const request = input as FocusSessionCommand | null;
    const id = typeof request?.requestId === "string" ? request.requestId.slice(0, 128) : "";
    const fail = (message: string) => ({ requestId: id, ok: false, message });
    if (!request || typeof request !== "object" || Array.isArray(request)
      || Object.keys(request).some(key => !["requestId", "action", "sessionId", "frameworkId", "cardId", "sessionComponentId", "conversationComponentId"].includes(key))
      || !id || request.requestId.length > 128
      || typeof request.sessionId !== "string" || !request.sessionId || request.sessionId.length > 1024
      || [request.cardId, request.sessionComponentId].some(value => typeof value !== "string" || !value || value.length > 128)
      || !(request.conversationComponentId === null || typeof request.conversationComponentId === "string" && request.conversationComponentId.length > 0 && request.conversationComponentId.length <= 128)
      || !FOCUS_COMMAND_ACTIONS.includes(request.action)
      || !["codex", "claude", "grok"].includes(request.frameworkId)) return fail("Unsupported or invalid Focus Panel command.");
    const fingerprint = JSON.stringify([request.action, request.sessionId, request.frameworkId, request.cardId, request.sessionComponentId, request.conversationComponentId]);
    const previous = requests.get(id);
    if (previous) return previous.fingerprint === fingerprint ? previous.result : fail("This request ID belongs to another command.");
    for (const [key, entry] of requests) {
      if (requests.size < 64) break;
      if (entry.complete) requests.delete(key);
    }
    if (requests.size >= 64 || activeSessions.has(request.sessionId)) return fail("A command is already in progress. Check the main AMO window.");
    activeSessions.add(request.sessionId);
    const entry = { fingerprint, complete: false, result: Promise.resolve(fail("Not started")) };
    entry.result = (async () => {
      try {
        const [session, card] = await Promise.all([ports.loadSession(request.sessionId), ports.loadCard(request.cardId)]);
        const component = (id: string, type: string) => card.components.find(value => value.componentId === id && value.type === type && value.schemaVersion === 1);
        const sessionComponent = component(request.sessionComponentId, "amo.session");
        const conversationComponent = request.conversationComponentId ? component(request.conversationComponentId, "amo.conversation") : undefined;
        const processing = card.components.find(value => value.type === "amo.processing" && value.schemaVersion === 1);
        const reference = sessionComponent?.data.sessionRef as { frameworkId?: string; sessionId?: string } | undefined;
        if (card.cardId !== request.cardId || card.archivedAt || !processing
          || processing.data.sourceComponentId !== request.sessionComponentId
          || (request.conversationComponentId ? conversationComponent?.data.sessionComponentId !== request.sessionComponentId : card.components.some(value => value.type === "amo.conversation" && value.schemaVersion === 1 && value.data.sessionComponentId === request.sessionComponentId))
          || reference?.frameworkId !== request.frameworkId || reference?.sessionId !== request.sessionId) return fail("Card conversation changed. Refresh Focus Panel before retrying.");
        if (session.sessionId !== request.sessionId || focusFrameworkId(session.tool) !== request.frameworkId) return fail("Session identity changed. Refresh Focus Panel before retrying.");
        if ((session.archivedAt || session.dismissedAt) && request.action !== "dismiss") return fail("Restore the archived session in AMO before using its actions.");
        if (request.action === "dismiss" && !session.archivedAt) return fail("Only an archived session can be hidden from AMO.");
        if (FOCUS_CONVERSATION_ACTIONS.includes(request.action) && !conversationComponent) return fail("This card has no conversation component. Attach one before using conversation actions.");
        if (request.action === "resume" && (!session.workspaceId && !session.workspacePath || session.tool === "codex-app" || session.targetBinding?.type === "codex-app-thread")) return fail("This conversation does not support a managed CLI resume.");
        if (request.action === "openApp" && request.frameworkId !== "codex") return fail("This session does not support a ChatGPT target.");
        const additionalCommand = request.action === "activate" || request.action === "resume" ? undefined : ports.commands?.[request.action];
        if (request.action !== "activate" && request.action !== "resume" && !additionalCommand) return fail("This action is not available in the main AMO window.");
        await ports.revealMain();
        if (request.action === "activate") await ports.activate(session);
        else if (request.action === "resume") await ports.resume(session);
        else await additionalCommand!(session);
        // Existing handlers can open a target chooser and report failures in main's feedback.
        return { requestId: id, ok: true, message: request.action === "bindInMain" ? "AMO opened. Find this session and drag its crosshair to the target window to bind it. Card processing and group are unchanged." : "Request handed to AMO. Check its window for target selection or action results. Card processing and group are unchanged." };
      } catch (error) { return fail(error instanceof Error ? error.message : "AMO could not route this request."); }
      finally { activeSessions.delete(request.sessionId); entry.complete = true; }
    })();
    requests.set(id, entry);
    return entry.result;
  };
}
