import { useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Circle, Clock3, Focus, Plus, RefreshCw, Save, Search, Terminal, X } from "lucide-react";
import { FocusRequestError, updateFocusCard } from "../api/focusPanelClient";
import { commandAvailable, createOperation, filterCards, TRIAGE_LABELS, type FocusCardView, type FocusOperation, type NoteDraft, type TriageState } from "../focus/model";
import { useFocusCards } from "../focus/useFocusCards";
import { useFocusCommands } from "../focus/useFocusCommands";
import { NewCardForm } from "../focus/NewCardForm";
import { useAmoThemeRuntime } from "../theme/amoTheme";
import { closeUtilityWindow, startUtilityWindowDrag, useUtilityWindowLifecycle } from "./utilityWindow";
import "../focus/focus.css";

type CardFeedback = { saving?: boolean; error?: string; conflict?: boolean; message?: string };
const GROUPS: (TriageState | "all")[] = ["pending", "reviewing", "later", "future", "handled", "all"];
const pathName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || "No workspace";
const formatExecution = (value: string) => value.replace(/_/g, " ");

export function FocusPanelApp() {
  useUtilityWindowLifecycle("focus");
  useAmoThemeRuntime();
  const feed = useFocusCards(), commands = useFocusCommands();
  const [group, setGroup] = useState<TriageState | "all">("pending");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, NoteDraft>>({});
  const [feedback, setFeedback] = useState<Record<string, CardFeedback>>({});
  const pending = useRef(new Map<string, FocusOperation>());
  const inFlight = useRef(new Set<string>());
  const visibleCards = filterCards(feed.cards, group, search);
  const unseen = feed.cards.filter(card => card.attention.hasUnseen).length;
  const dirtyCount = Object.keys(drafts).length;
  const unavailableDrafts = Object.entries(drafts).filter(([id]) => !feed.cards.some(card => card.cardId === id));

  function editNote(card: FocusCardView, text: string) {
    setDrafts(previous => {
      const next = { ...previous };
      if (text === card.triage.note && !inFlight.current.has(card.cardId) && !pending.current.has(card.cardId)) delete next[card.cardId];
      else next[card.cardId] = { ...(previous[card.cardId] ?? { baseRevision: card.revision, baseNote: card.triage.note }), text };
      return next;
    });
  }
  async function mutate(card: FocusCardView, operation: FocusOperation) {
    if (inFlight.current.has(card.cardId)) return;
    // Unknown responses retain this exact operation for replay, even if the note is edited again.
    const request = pending.current.get(card.cardId) ?? operation;
    pending.current.set(card.cardId, request); inFlight.current.add(card.cardId);
    setFeedback(previous => ({ ...previous, [card.cardId]: { saving: true } }));
    try {
      const result = await updateFocusCard(card.cardId, request);
      feed.acceptCard(result.card); pending.current.delete(card.cardId);
      setDrafts(previous => {
        const draft = previous[card.cardId];
        if (!draft) return previous;
        const next = { ...previous };
        if (request.note !== undefined && draft.text === request.note) delete next[card.cardId];
        else if (request.note !== undefined || draft.baseNote === result.card.triage.note) next[card.cardId] = { ...draft, baseRevision: result.card.revision, baseNote: result.card.triage.note };
        return next;
      });
      setFeedback(previous => ({ ...previous, [card.cardId]: { message: request.action === "handle" ? card.session ? `Handled through update ${request.throughGeneration}. Session execution is unchanged.` : "Card handled." : request.note !== undefined ? "Saved." : "Queue updated." } }));
      feed.refresh();
    } catch (reason) {
      const certain = reason instanceof FocusRequestError && reason.status >= 400 && reason.status < 500;
      if (certain) pending.current.delete(card.cardId);
      setFeedback(previous => ({ ...previous, [card.cardId]: { error: reason instanceof Error ? reason.message : "Could not save. Your draft is kept.", conflict: reason instanceof FocusRequestError && reason.status === 409 } }));
      if (certain) feed.refresh();
    } finally { inFlight.current.delete(card.cardId); }
  }
  function useLatest(card: FocusCardView) {
    setDrafts(previous => previous[card.cardId] ? { ...previous, [card.cardId]: { ...previous[card.cardId], baseRevision: card.revision, baseNote: card.triage.note } } : previous);
    setFeedback(previous => ({ ...previous, [card.cardId]: {} }));
  }
  function saveNote(card: FocusCardView) { const draft = drafts[card.cardId]; if (draft) void mutate(card, createOperation(card, "set-triage", crypto.randomUUID(), { draft })); }

  return <main className="amo-focus-panel">
    <header className="amo-focus-header" onPointerDown={startUtilityWindowDrag}>
      <span className="amo-focus-mark"><Focus size={19} /></span><div><h1>Focus Panel</h1><p>Your tasks, at your pace</p></div>
      <div className="amo-focus-header-actions"><button type="button" aria-label="Refresh Focus Panel" title="Refresh tasks" onClick={feed.refresh}><RefreshCw size={15} /></button><button type="button" aria-label="Hide Focus Panel" title="Hide panel · keep drafts" onClick={() => void closeUtilityWindow("focus")}><X size={17} /></button></div>
    </header>
    <div className="amo-focus-summary"><span><i className={unseen ? "has-new" : ""} />{unseen ? `${unseen} with new updates` : "No unseen updates"}</span><button className="amo-focus-new-card" onClick={() => setCreating(!creating)}><Plus size={12} />New card</button></div>
    <nav className="amo-focus-groups" aria-label="Review queue groups">{GROUPS.map(state => {
      const count = state === "all" ? feed.cards.length : feed.cards.filter(card => card.triage.state === state).length;
      const updates = feed.cards.some(card => (state === "all" || card.triage.state === state) && card.attention.hasUnseen);
      return <button type="button" key={state} aria-pressed={group === state} className={group === state ? "is-selected" : ""} onClick={() => { setGroup(state); setSelected(null); }}><span>{state === "all" ? "All tasks" : TRIAGE_LABELS[state]}{updates && <i className="amo-focus-tab-dot" />}</span><small>{count}</small></button>;
    })}</nav>
    <label className="amo-focus-search"><Search size={15} /><input aria-label="Search tasks and workspaces" type="search" value={search} placeholder="Search tasks or workspaces" onChange={event => setSearch(event.target.value)} /></label>
    {feed.error && <div className="amo-focus-feed-error" role="alert"><strong>Updates unavailable.</strong> {feed.error}<button onClick={feed.refresh}>Retry refresh</button></div>}
    <section className="amo-focus-list" aria-label={`${group === "all" ? "All" : TRIAGE_LABELS[group]} tasks`}>
      <NewCardForm open={creating} onClose={() => setCreating(false)} onCreated={id => { setCreating(false); setGroup("pending"); setSearch(""); setSelected(id); feed.refresh(); }} />
      {group === "all" && unavailableDrafts.map(([id, draft]) => <article key={`draft-${id}`} className="amo-focus-create"><strong>Draft kept outside this queue</strong><p>This card was archived or no longer has a processing component. Your unsaved text is still available to select and copy.</p><textarea aria-label={`Recovered note draft ${id}`} readOnly value={draft.text} /><small>Card {id}</small></article>)}
      {visibleCards.map(card => {
        const expanded = selected === card.cardId, draft = drafts[card.cardId], notice = feedback[card.cardId];
        const uncertain = pending.current.has(card.cardId), saving = !!notice?.saving;
        const stale = !!draft && draft.baseRevision !== card.revision;
        const locked = saving || uncertain || !!notice?.conflict;
        const command = commands.status[card.cardId];
        return <article key={card.cardId} className={`amo-focus-card ${expanded ? "is-expanded" : ""} ${card.attention.hasUnseen ? "has-update" : ""}`}>
          <button type="button" className="amo-focus-card-toggle" aria-expanded={expanded} aria-controls={`focus-detail-${card.cardId}`} onClick={() => setSelected(expanded ? null : card.cardId)}>
            <span className="amo-focus-card-topline"><span className="amo-focus-project" title={card.session?.workspacePath}>{card.session ? pathName(card.session.workspacePath) : "Independent card"}</span>{card.session && <span className="amo-focus-framework">{card.session.sessionRef.frameworkId}</span>}{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
            <strong className="amo-focus-title">{card.title || "Untitled task"}</strong>
            <span className="amo-focus-badges">{card.attention.hasUnseen && <span className="amo-focus-new">New update · {card.attention.generation}</span>}{card.session && <><span className={`amo-focus-presence is-${card.session.presence}`}>Session · {card.session.presence}</span><span>{formatExecution(card.session.execution)}</span></>}{!card.session && <span>{TRIAGE_LABELS[card.triage.state]}</span>}{draft && <span className="amo-focus-draft-badge">Draft</span>}</span>
          </button>
          {expanded && <div id={`focus-detail-${card.cardId}`} className="amo-focus-detail">
            <div className="amo-focus-review-status"><span>{TRIAGE_LABELS[card.triage.state]}</span><span>{card.attention.kind ? `Latest: ${card.attention.kind}` : "No attention event"}</span></div>
            {card.session && <p className="amo-focus-workspace" title={card.session.workspacePath}>{card.session.workspacePath || "No workspace recorded"}</p>}
            {card.session && card.conversation && card.conversation.sessionComponentId === card.session.componentId && <div className="amo-focus-conversation"><div className="amo-focus-conversation-heading"><strong>Conversation</strong><span>{card.conversation.surface === "cli" ? "CLI / TUI" : card.conversation.surface === "app" ? "App / GUI" : "Unbound"}</span></div><div className="amo-focus-badges"><span>{card.conversation.bindingKind}</span><span className={`amo-focus-availability is-${card.conversation.availability}`}>{card.conversation.availability}</span></div><div className="amo-focus-cli-actions"><button disabled={!commands.ready || !commandAvailable(card, "activate") || !!command?.pending} title="Ask AMO to open this conversation" onClick={() => void commands.send(card, "activate")}><Terminal size={14} />{card.conversation.surface === "app" ? "Open app" : card.conversation.surface === "cli" ? "Open CLI" : "Open conversation"}</button>{card.conversation.surface !== "app" && <button disabled={!commands.ready || !commandAvailable(card, "resume") || !!command?.pending} title="Ask AMO to resume this session in CLI" onClick={() => void commands.send(card, "resume")}><RefreshCw size={13} />Resume</button>}</div>{!commandAvailable(card, "activate") && !commandAvailable(card, "resume") && <p className="amo-focus-caption">Conversation actions are unavailable for this reference.</p>}</div>}
            {card.session && (!card.conversation || card.conversation.sessionComponentId !== card.session.componentId) && <p className="amo-focus-caption">No conversation attached to this session reference.</p>}
            {command && <p role="status" className="amo-focus-command-status">{command.message}</p>}
            <label className="amo-focus-note-label" htmlFor={`focus-note-${card.cardId}`}>Task note <span>{(draft?.text ?? card.triage.note).length}/2000</span></label>
            <textarea id={`focus-note-${card.cardId}`} aria-label={`Review note for ${card.title}`} maxLength={2000} value={draft?.text ?? card.triage.note} placeholder="Keep context or a next step…" onChange={event => editNote(card, event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!locked && !stale) saveNote(card); } }} />
            {stale && <div className="amo-focus-stale" role="status">This card changed while you were editing. Your draft is kept.{draft.baseNote !== card.triage.note && <div className="amo-focus-latest-note"><strong>Saved note now:</strong><p>{card.triage.note || "(empty)"}</p></div>}<button disabled={saving || uncertain} onClick={() => useLatest(card)}>Keep draft with latest revision</button></div>}
            <div className="amo-focus-note-actions"><span>{draft ? "Unsaved note" : "Note saved"}</span><button disabled={!draft || locked || stale} onClick={() => saveNote(card)}><Save size={13} />Save note</button></div>
            <label className="amo-focus-triage-label">Task queue<select aria-label={`Review queue for ${card.title}`} value={card.triage.state} disabled={locked} onChange={event => { const state = event.target.value as Exclude<TriageState, "handled">; void mutate(card, createOperation(card, "set-triage", crypto.randomUUID(), { state })); }}>{card.triage.state === "handled" && <option value="handled" disabled>Handled</option>}{GROUPS.filter((state): state is Exclude<TriageState, "handled"> => state !== "all" && state !== "handled").map(state => <option key={state} value={state}>{TRIAGE_LABELS[state]}</option>)}</select></label>
            {notice?.error && <div className="amo-focus-card-error" role="alert">{notice.error}</div>}
            {uncertain && !saving && <button className="amo-focus-retry" onClick={() => void mutate(card, pending.current.get(card.cardId)!)}><RefreshCw size={13} />Retry same request</button>}
            {notice?.conflict && !stale && <button className="amo-focus-retry" onClick={() => useLatest(card)}>I reviewed the latest card · allow retry</button>}
            {notice?.message && <p className="amo-focus-operation-status" role="status">{notice.message}</p>}
            <button className="amo-focus-handle" disabled={locked || card.triage.state === "handled" && !card.attention.hasUnseen} onClick={() => void mutate(card, createOperation(card, "handle", crypto.randomUUID()))}><Check size={15} />{saving ? "Saving…" : card.triage.state === "handled" && !card.attention.hasUnseen ? "Handled" : card.session ? "Handle this update" : "Mark handled"}</button>
            {card.session && <p className="amo-focus-caption">{card.attention.kind === "permission" ? "Handling tracks your review; permission still needs a response in the conversation." : "Opening a conversation does not mark this update handled."}</p>}
          </div>}
        </article>;
      })}
      {!visibleCards.length && <div className="amo-focus-empty"><span>{feed.loading ? <Clock3 size={27} /> : <Circle size={27} />}</span><h2>{feed.loading ? "Loading your queue…" : search ? "No matching tasks" : group === "pending" ? "Your pending queue is clear" : "Nothing here yet"}</h2><p>{search ? "Try a task title, workspace or provider." : "Task updates appear here. You choose what to review now or leave for later."}</p></div>}
    </section>
    <footer className="amo-focus-footer"><span><i className={feed.visible && !feed.error ? "is-live" : ""} />{feed.error ? "Retrying updates" : feed.visible ? "Live updates" : "Updates paused"}</span>{dirtyCount ? <button className="amo-focus-find-drafts" onClick={() => { setGroup("all"); setSearch(""); setSelected(Object.keys(drafts)[0]); }}>{dirtyCount} unsaved {dirtyCount === 1 ? "note" : "notes"}</button> : <span>You choose the next step</span>}</footer>
  </main>;
}
