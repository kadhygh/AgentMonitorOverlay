import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { CardRequestError, createCard, plannedCardOperation, type CreateCardOperation } from "../api/cardClient";

export function NewCardForm({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState(""), [note, setNote] = useState("");
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  const pending = useRef<CreateCardOperation | null>(null);
  const inFlight = useRef(false);
  async function submit() {
    if (inFlight.current || !title.trim()) return;
    const operation = pending.current ?? plannedCardOperation(crypto.randomUUID(), title, note, crypto.randomUUID(), crypto.randomUUID());
    pending.current = operation; inFlight.current = true; setSaving(true); setError("");
    try {
      const result = await createCard(operation);
      pending.current = null; setTitle(""); setNote(""); onCreated(result.card.cardId);
    } catch (reason) {
      if (reason instanceof CardRequestError && reason.status >= 400 && reason.status < 500) pending.current = null;
      setError(reason instanceof Error ? reason.message : "Could not create the card. Your draft is kept.");
    } finally { inFlight.current = false; setSaving(false); }
  }
  if (!open) return null;
  return <form className="amo-focus-create" aria-label="New planned card" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div className="amo-focus-create-heading"><strong>New card</strong><button type="button" aria-label="Close new card form" onClick={onClose}><X size={14} /></button></div>
    <p>Capture a plan or task. No session is required.</p>
    <label>Title<input autoFocus aria-label="New card title" required maxLength={300} value={title} disabled={saving || !!pending.current} onChange={event => setTitle(event.target.value)} placeholder="What would you like to work on?" /></label>
    <label>Note <small>{note.length}/2000</small><textarea aria-label="New card note" maxLength={2000} value={note} disabled={saving || !!pending.current} onChange={event => setNote(event.target.value)} placeholder="Optional context or next step" /></label>
    {error && <div role="alert" className="amo-focus-card-error">{error}</div>}
    <button type="submit" disabled={saving || !title.trim()}><Plus size={14} />{saving ? "Creating…" : pending.current ? "Retry same creation" : "Create card"}</button>
  </form>;
}
