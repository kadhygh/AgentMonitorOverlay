// 复制引用 (2026-11-23, the user: 可以，按你的建议做): text naming a 协作, a 子会话, a message, a 中转会话 — pasted into a
// chat or a Studio session, a person reads its words and an AI its id. The same words as AMO Studio's (protocol
// refs.ts, which also reads these back for cowork_* / team_*): change them together. In a message they are recognised when shown (RefChip), never stored any
// other way.

export interface Titled {
  id: string;
  title: string;
}

/** A title on one line (as Studio's protocol refs.ts oneLine). */
const line = (title: string) => title.replace(/\s+/g, " ").trim();
export const coworkRef = (c: Titled) => `协作「${line(c.title)}」 cowork:${c.id}`;
export const subRef = (s: Titled, coworkId: string) => `子会话「${line(s.title)}」 thread:${s.id}（协作 cowork:${coworkId}）`;
/** A 事项 (2026-11-25; its id is its thread's, so Studio's refId reads it as a 子会话's): 「事项 3「标题」 thread:…」. */
export const matterRef = (m: Titled & { no: number }, coworkId: string) => `事项 ${m.no}「${line(m.title)}」 thread:${m.id}（协作 cowork:${coworkId}）`;
export const requestRef = (t: Titled) => `中转会话「${line(t.title)}」 thread:${t.id}`;
/** A message: in a 协作 (its 群聊 or a 子会话) with the 协作; elsewhere with the conversation's name. */
export const messageRef = (seq: number, where: { cowork: Titled } | { name: string }) => ("cowork" in where ? `#${seq}（协作「${line(where.cowork.title)}」 cowork:${where.cowork.id}）` : `#${seq}（${line(where.name)}）`);

/** What a toast says was copied. */
export const copiedText = (what: string) => `已复制${what}的引用，贴进聊天或 AI 会话里都认得`;

export type Ref = { kind: "cowork"; id: string } | { kind: "thread"; id: string } | { kind: "studio"; device: string; session: string };

const ID = "[A-Za-z0-9_][A-Za-z0-9_-]{0,79}";
/**
 * A ref in text, with the words copied before it (「协作「标题」 」, 「子会话「…」 」, 「事项 3「…」 」, 「Studio 会话「…」 」, or just 「协作 」)
 * taken in: the chip shows the name once. Not inside a word or a path (`a/thread:x`, `xcowork:y`).
 */
export const REF_SOURCE = `(?:(?:协作|子会话|事项(?: \\d{1,5})?|中转会话|Studio 会话)(?:「([^」\\n]{0,200})」)? ?)?(?<![A-Za-z0-9_/:.-])(cowork:${ID}|thread:${ID}|studio:[A-Za-z0-9_-]{6,64}:${ID})(?![A-Za-z0-9_-])`;

/** `cowork:<id>` / `thread:<id>` / `studio:<设备号>:<会话>` → the ref; null for anything else. */
export function parseRef(text: string): Ref | null {
  const m = new RegExp(`^(?:cowork:(${ID})|thread:(${ID})|studio:([A-Za-z0-9_-]{6,64}):(${ID}))$`).exec(text);
  if (!m) return null;
  if (m[1]) return { kind: "cowork", id: m[1] };
  if (m[2]) return { kind: "thread", id: m[2] };
  return { kind: "studio", device: m[3]!, session: m[4]! };
}

/** The refs in a piece of text: where each is (with the words taken in), the ref and the name copied with it. */
export function findRefs(text: string): Array<{ index: number; length: number; ref: Ref; raw: string; label: string | null }> {
  const out: Array<{ index: number; length: number; ref: Ref; raw: string; label: string | null }> = [];
  for (const m of text.matchAll(new RegExp(REF_SOURCE, "g"))) {
    const ref = parseRef(m[2]!);
    if (ref) out.push({ index: m.index ?? 0, length: m[0].length, ref, raw: m[2]!, label: m[1] ?? null });
  }
  return out;
}

/** What the content is asked to open (shell takeOpen / onOpen: `cowork:<id>`, `thread:<id>`; a notification's `thread:transfer:<id>`). */
export function parseOpen(text: string): { kind: "cowork" | "thread"; id: string } | null {
  const at = text.indexOf(":");
  const kind = text.slice(0, at);
  const id = text.slice(at + 1);
  return at > 0 && id && (kind === "cowork" || kind === "thread") ? { kind, id } : null;
}
