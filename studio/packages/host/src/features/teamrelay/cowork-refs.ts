import { refId } from "@amo-studio/protocol";
import { agentParty, GATE_LABEL, MATTER_STATUSES, MATTER_STATUS_LABEL, personParty, resolveAgentRef, type Cowork, type GateKind, type CoworkAgent, type Matter, type MatterStatus, type Party } from "@amo-studio/relay/light";

// 指代 (2026-11-24, plans/collab-agent-spec.md §3「所有工具认「事项 3」「#7」、显示名（「老李的主控」）、人从中转复制来的整行引用，
// 不要求先查 mark」): what the cowork_* tools take for a 事项, a message, an AI or a person, and what they resolve it to.

/** 「事项 3」「事项3」 anywhere in the text (a whole line the person copied too). */
const MATTER_NO = /事项\s*(\d+)/;

/** A 事项 by 「事项 N」, its thread id or a copied `thread:<id>` line; null when it names none of this 协作's. */
export function matterRef(c: Pick<Cowork, "matters">, value: unknown): Matter | null {
  if (typeof value === "number") return c.matters?.find((m) => m.no === value) ?? null;
  if (typeof value !== "string" || !value.trim()) return null;
  const no = MATTER_NO.exec(value);
  if (no) return c.matters?.find((m) => m.no === Number(no[1])) ?? null;
  const id = refId(value, "thread");
  return c.matters?.find((m) => m.id === id) ?? null;
}

/**
 * Where to post: the 群聊 (nothing, 「群聊」, the cowork's id) or a thread — a 事项 by 「事项 N」, else the id as given (an old
 * 子会话). `matter` is set when it is one.
 */
export function threadRef(c: Pick<Cowork, "id" | "matters">, value: unknown): { threadId: string; matter: Matter | null } {
  if (value === undefined || value === null || (typeof value === "string" && (!value.trim() || value.trim() === "群聊"))) return { threadId: c.id, matter: null };
  const m = matterRef(c, value);
  if (m) return { threadId: m.id, matter: m };
  if (typeof value === "string" && MATTER_NO.test(value)) throw new Error(`这个协作里没有${MATTER_NO.exec(value)![0]}：开着的事项在 cowork_read（不带参数）里。`);
  const id = typeof value === "string" ? refId(refId(value, "thread"), "cowork") : String(value);
  return { threadId: id, matter: null };
}

/** A message's #seq: 7, 「#7」, 「7」 or a copied 「#7(协作… cowork:<id>)」. */
export function seqRef(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const m = /#?\s*(\d+)/.exec(value.trim());
  return m ? Number(m[1]) : null;
}

/** Several #seqs (a list, or one). */
export function seqsRef(value: unknown): number[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return [...new Set(list.map(seqRef).filter((n): n is number => n !== null))];
}

const norm = (s: string) => s.replace(/^@/, "").replace(/\s+/g, "").replace(/·/g, "").toLowerCase();

/**
 * An AI of the 协作 by its mark, its name (「程序老李 的 AI · 射速」), its label, or 「X 的主控」「X的主控」 (X's side's 主控);
 * null when none or several fit.
 */
export function agentRef(c: Pick<Cowork, "agents">, value: string): CoworkAgent | null {
  const v = value.trim().replace(/^@/, "");
  if (!v) return null;
  const exact = c.agents.find((a) => a.mark === v);
  if (exact) return exact;
  // The service's own reading first (protocol/matters.ts, 2026-11-25): 「X的主控」 falls back to X's 未分角色 AIs, 「事项 N 的执行」,
  // 「X 的 AI」, copied lines; what it does not settle, the looser matching below.
  const marks = resolveAgentRef(v, c.agents.map((a) => ({ mark: a.mark, name: a.name, label: a.label, owner: a.owner, role: a.role ?? "unassigned", matterNo: a.matterNo ?? null })));
  if (marks.length === 1) return c.agents.find((a) => a.mark === marks[0]) ?? null;
  if (marks.length > 1) return null;
  const lead = /^(.+?)\s*(?:这一方)?\s*的\s*主控$/.exec(v);
  if (lead) {
    const side = norm(lead[1]!);
    const found = c.agents.filter((a) => a.role === "lead" && (norm(a.owner) === side || norm(a.owner).startsWith(side)));
    if (found.length === 1) return found[0]!;
  }
  const n = norm(v);
  for (const pick of [(a: CoworkAgent) => norm(a.name) === n, (a: CoworkAgent) => norm(a.label) === n, (a: CoworkAgent) => norm(a.name).includes(n)]) {
    const found = c.agents.filter(pick);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) return null;
  }
  return null;
}

/** A person of the 协作 by name (with or without @). */
export function personRef(c: Pick<Cowork, "members">, value: string): string | null {
  const v = value.trim().replace(/^@/, "");
  if (c.members.includes(v)) return v;
  const found = c.members.filter((m) => norm(m) === norm(v));
  return found.length === 1 ? found[0]! : null;
}

/** A person or an AI: `person:X`, `agent:<mark>`, a name — people first, then AIs. */
export function partyRef(c: Pick<Cowork, "members" | "agents">, value: unknown): Party | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  if (v.startsWith("person:")) return personRef(c, v.slice(7)) ? personParty(personRef(c, v.slice(7))!) : null;
  if (v.startsWith("agent:")) {
    const a = agentRef(c, v.slice(6));
    return a ? agentParty(a.mark) : null;
  }
  const p = personRef(c, v);
  if (p) return personParty(p);
  const a = agentRef(c, v);
  return a ? agentParty(a.mark) : null;
}

/** A 事项 status by its id or its label (「等对方」「已推送」…). */
export function statusRef(value: unknown): MatterStatus | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if ((MATTER_STATUSES as readonly string[]).includes(v)) return v as MatterStatus;
  const found = MATTER_STATUSES.find((s) => MATTER_STATUS_LABEL[s] === v);
  return found ?? null;
}

/** A 闸门 by its id or a word of it (「口径」「判红」「合 master」「别人的东西」「对外发布」, 2026-11-25: cowork_ask's gate); null if none. */
export function gateRef(value: unknown): GateKind | null {
  if (typeof value !== "string") return null;
  const v = value.trim().replace(/\s+/g, "").toLowerCase();
  if ((Object.keys(GATE_LABEL) as string[]).includes(v)) return v as GateKind;
  const words: Array<[GateKind, RegExp]> = [["rules", /口径/], ["red", /判红/], ["master", /master|合并|合进/], ["others", /别人/], ["release", /发布/]];
  return words.find(([, re]) => re.test(v))?.[0] ?? null;
}
