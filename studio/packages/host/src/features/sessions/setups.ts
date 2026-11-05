import { MAX_SUBSESSION_SETUPS, SUBSESSION_EXTRA_MAX, SUBSESSION_PERMISSIONS, type Id, type SubsessionSetup } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import type { Store } from "../../store/store.js";

// 子会话设定 (2026-11-05, plans/done/subsession-mention-2026-11-05.md): what the person set up with @ 开子会话… comes with
// the message that names it and is kept under the session it was sent to, by name; that session's session_start with
// `setup: name` starts from it. A later setup of the same name replaces the earlier one.

export const SUBSESSION_SETUP_KEY = "subsession-setup:";
/** How many a session keeps (the newest). */
const KEEP = 30;

/** A list of setups as sent (POST /api/sessions/:id/messages, POST /api/tasks' firstSession), checked. */
export function checkSetups(list: unknown): SubsessionSetup[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX_SUBSESSION_SETUPS) throw new HostError("bad_request", `subsessions must be a list of at most ${MAX_SUBSESSION_SETUPS}`);
  return list.map((x: unknown) => {
    const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
    const name = typeof o.name === "string" ? o.name.trim().replace(/^@/, "") : "";
    if (!name || name.length > 100) throw new HostError("bad_request", "a sub-session setup needs a name (at most 100 characters)");
    if (typeof o.profileId !== "string" || !o.profileId) throw new HostError("bad_request", "a sub-session setup needs a profileId");
    const model = o.model === null || o.model === undefined || o.model === "" ? null : typeof o.model === "string" && o.model.length <= 100 ? o.model : undefined;
    if (model === undefined) throw new HostError("bad_request", "a sub-session setup's model is a model id or null");
    if (o.effort !== undefined && (typeof o.effort !== "string" || o.effort.length > 40)) throw new HostError("bad_request", "effort must be text, e.g. high");
    if (o.fast !== undefined && typeof o.fast !== "boolean") throw new HostError("bad_request", "fast must be true or false");
    if (o.permission !== undefined && !SUBSESSION_PERMISSIONS.includes(o.permission as never)) throw new HostError("bad_request", `permission must be one of: ${SUBSESSION_PERMISSIONS.join(", ")}`);
    if (o.extra !== undefined && (typeof o.extra !== "string" || o.extra.length > SUBSESSION_EXTRA_MAX)) throw new HostError("bad_request", `extra is text of at most ${SUBSESSION_EXTRA_MAX} characters`);
    const extra = typeof o.extra === "string" ? o.extra.trim() : "";
    return {
      name,
      profileId: o.profileId,
      model,
      ...(typeof o.effort === "string" && o.effort ? { effort: o.effort } : {}),
      ...(typeof o.fast === "boolean" ? { fast: o.fast } : {}),
      ...(o.permission ? { permission: o.permission as SubsessionSetup["permission"] & string } : {}),
      ...(extra ? { extra } : {}),
    };
  });
}

/** The setups kept for a session, oldest first. */
export function readSetups(store: Store, sessionId: Id): SubsessionSetup[] {
  try {
    const v = JSON.parse(store.getKv(SUBSESSION_SETUP_KEY + sessionId)?.value ?? "[]") as unknown;
    return Array.isArray(v) ? (v as SubsessionSetup[]) : [];
  } catch {
    return [];
  }
}

/** Keeps `setups` for the session (each replacing one of the same name). */
export function rememberSetups(store: Store, sessionId: Id, setups: readonly SubsessionSetup[]): void {
  if (!setups.length) return;
  const names = new Set(setups.map((s) => s.name));
  const next = [...readSetups(store, sessionId).filter((s) => !names.has(s.name)), ...setups].slice(-KEEP);
  store.setKv(SUBSESSION_SETUP_KEY + sessionId, JSON.stringify(next));
}
