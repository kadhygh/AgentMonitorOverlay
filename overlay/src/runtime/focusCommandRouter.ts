import type { AgentSession } from "../types";
import type { Card } from "../api/cardClient";

export interface FocusSessionCommand {
  requestId: string;
  action: "activate" | "resume";
  sessionId: string;
  frameworkId: string;
  cardId: string;
  sessionComponentId: string;
  conversationComponentId: string;
}
export interface FocusCommandResult { requestId: string; ok: boolean; message: string }
interface FocusCommandPorts {
  loadSession(id: string): Promise<AgentSession>;
  loadCard(id: string): Promise<Card>;
  revealMain(): Promise<void>;
  activate(session: AgentSession): Promise<void>;
  resume(session: AgentSession): Promise<void>;
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
      || [request.cardId, request.sessionComponentId, request.conversationComponentId].some(value => typeof value !== "string" || !value || value.length > 128)
      || !["activate", "resume"].includes(request.action)
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
        const conversationComponent = component(request.conversationComponentId, "amo.conversation");
        const processing = card.components.find(value => value.type === "amo.processing" && value.schemaVersion === 1);
        const reference = sessionComponent?.data.sessionRef as { frameworkId?: string; sessionId?: string } | undefined;
        if (card.cardId !== request.cardId || card.archivedAt || !processing
          || processing.data.sourceComponentId !== request.sessionComponentId
          || conversationComponent?.data.sessionComponentId !== request.sessionComponentId
          || reference?.frameworkId !== request.frameworkId || reference?.sessionId !== request.sessionId) return fail("Card conversation changed. Refresh Focus Panel before retrying.");
        if (session.sessionId !== request.sessionId || focusFrameworkId(session.tool) !== request.frameworkId) return fail("Session identity changed. Refresh Focus Panel before retrying.");
        if (session.archivedAt || session.dismissedAt) return fail("Restore the archived session in AMO before opening it.");
        if (request.action === "resume" && (!session.workspaceId && !session.workspacePath || session.tool === "codex-app" || session.targetBinding?.type === "codex-app-thread")) return fail("This conversation does not support a managed CLI resume.");
        await ports.revealMain();
        if (request.action === "activate") await ports.activate(session);
        else await ports.resume(session);
        // Existing handlers can open a target chooser and report failures in main's feedback.
        return { requestId: id, ok: true, message: "Request handed to AMO. Check its window for target selection or launch results. Your processing state is unchanged." };
      } catch (error) { return fail(error instanceof Error ? error.message : "AMO could not route this request."); }
      finally { activeSessions.delete(request.sessionId); entry.complete = true; }
    })();
    requests.set(id, entry);
    return entry.result;
  };
}
