import { useEffect, useState } from "react";
import { BROKER_SESSIONS_URL, getBrokerJson } from "../api/brokerClient";
import { TaskCard, type TaskCardCommands } from "../components/TaskCard";
import { focusFrameworkId, type FocusCommandAction } from "../runtime/focusCommandRouter";
import type { AgentSession } from "../types";
import type { FocusCardView } from "./model";
import { useFocusCommands } from "./useFocusCommands";
import "./focus-session-detail.css";

/** The same AMO presentation, with actions owned by the main native window. */
export function FocusSessionDetail({ card }: { card: FocusCardView }) {
  const [loaded, setLoaded] = useState<{ identity: string; session: AgentSession } | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const commands = useFocusCommands();
  const reference = card.session?.sessionRef;
  const identity = JSON.stringify([card.cardId, card.session?.componentId, reference?.frameworkId, reference?.sessionId, card.conversation?.componentId]);
  const session = loaded?.identity === identity ? loaded.session : null;
  const status = commands.status[card.cardId];
  useEffect(() => {
    let disposed = false;
    setError("");
    if (!reference || card.session?.presence === "detached") { setLoaded(null); return; }
    void getBrokerJson<{ session: AgentSession }>(`${BROKER_SESSIONS_URL}/${encodeURIComponent(reference.sessionId)}`, { timeoutMs: 5000 })
      .then(result => {
        if (disposed) return;
        if (result.session?.sessionId !== reference.sessionId || focusFrameworkId(result.session.tool) !== reference.frameworkId) throw new Error("Session identity changed. Refresh this card before using its actions.");
        setLoaded({ identity, session: result.session });
      })
      .catch(reason => { if (!disposed) { setLoaded(null); setError(reason instanceof Error ? reason.message : "Could not load this session."); } });
    return () => { disposed = true; };
  }, [identity, card.session?.presence, card.session?.execution, card.conversation?.availability,
    card.conversation?.bindingKind, card.conversation?.surface, card.attention.generation,
    card.attention.updatedAt, card.updatedAt, refresh, status?.pending]);

  if (!card.session) return <p className="focus-session-empty">Independent card · no session attached.</p>;
  if (card.session.presence === "detached") return <p className="focus-session-empty">The referenced session is unavailable. Your card and notes are retained.</p>;
  const conversationAvailable = !!card.conversation && card.conversation.sessionComponentId === card.session.componentId;
  const appConversation = card.conversation?.surface === "app" || session?.tool === "codex-app" || session?.targetBinding?.type === "codex-app-thread";
  const send = (action: FocusCommandAction) => { void commands.send(card, action); };
  const cardCommands: TaskCardCommands = {
    openNote: () => send("openNote"), openCanvas: () => send("openCanvas"), openVSCode: () => send("openVSCode"),
    markReviewed: () => send("markReviewed"), unbindWindow: () => send("unbindWindow"), archive: () => send("archive"),
    dismiss: () => send("dismiss"), openApp: () => send("openApp"), activate: () => send("activate"), resume: () => send("resume"),
    handleAttention: () => send("handleAttention"), openLaunchPanel: () => send("openLaunchPanel"),
    openWorkspacePanel: () => send("openWorkspacePanel"), startWindowBindDrag: () => send("bindInMain"),
  };
  const busy = !!status?.pending;
  return <section className="focus-session-detail" aria-label="Session details">
    <header className="focus-session-detail-heading"><strong>Session</strong><button type="button" onClick={() => setRefresh(value => value + 1)} disabled={busy}>Refresh</button></header>
    {error ? <p role="alert">{error}</p> : !session ? <p role="status">Loading session…</p> : <>
      <dl className="focus-session-facts">
        <dt>Session</dt><dd>{session.sessionId}</dd>
        <dt>Execution</dt><dd>{session.state}</dd>
        <dt>Conversation</dt><dd>{conversationAvailable ? `${card.conversation!.surface} · ${card.conversation!.availability}` : "No conversation component · conversation actions unavailable"}</dd>
        <dt>Workspace</dt><dd>{session.workspacePath || session.cwd || "Not attached"}</dd>
      </dl>
      <fieldset disabled={!!card.archivedAt || !commands.ready || busy} className={`focus-session-card-shell ${!conversationAvailable ? "no-conversation" : ""} ${appConversation ? "app-conversation" : ""}`}>
        <legend className="focus-session-legend">AMO session actions</legend>
        <div className={`session-row focus-session-card state-${session.state}`}>
          <TaskCard session={session} commands={cardCommands} activating={busy} openingTarget={null} openingVSCode={busy}
            unbindingWindow={busy} archiving={busy} reviewing={busy} dismissing={busy} attentionSignal={card.attention.hasUnseen}
            attentionVisualActive={false} windowBindDragging={false} />
        </div>
        {conversationAvailable && !session.archivedAt && !session.dismissedAt ? <div className="focus-session-extra-actions">
          <button type="button" onClick={() => send("activate")} disabled={!card.conversation?.capabilities.activate}>Return to conversation</button>
          <button type="button" onClick={() => send("bindInMain")}>Bind in AMO…</button>
        </div> : null}
        <div className="focus-session-extra-actions">
          <button type="button" onClick={() => send(session.archivedAt ? "dismiss" : "archive")} disabled={!!session.dismissedAt}>
            {session.archivedAt ? "Hide archived session from AMO" : "Archive session in AMO"}
          </button>
        </div>
      </fieldset>
      <p className="focus-session-explanation">These are Session actions. Session archive, Card archive, and removing a conversation component are separate. Opening a target does not change this card’s group or mark it handled.</p>
      {card.archivedAt ? <p role="status">This Card is archived. Restore the Card before using its Session actions.</p> : null}
      {!commands.ready ? <p role="status">Native AMO actions are unavailable in this browser. Session content remains readable.</p> : null}
    </>}
    {status?.message ? <p className="focus-session-command-result" role="status">{status.message}</p> : null}
  </section>;
}
