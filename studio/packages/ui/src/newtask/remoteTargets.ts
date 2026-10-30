import { peerPresence, type PeerPresence, type RemoteCatalog, type RemoteState } from "@amo-studio/protocol";
import { rankChoices, type Choice } from "./choices.js";

// 新任务页的远程模式 (plans/remote-page-and-new-task.md 4.1, 2026-10-29): 「在别的设备上」 creates the task on another
// computer of the person's — one that allowed this computer to pair — from what that computer allows (its catalog).
// Pure logic; the page is RemoteDraft.tsx.

/** A device a task can be created on: paired, and it allowed this computer. */
export interface RemoteTarget {
  key: string;
  account: string;
  device: string;
  name: string;
  presence: PeerPresence;
}

export const targetKey = (p: { account: string; device: string }) => `${p.account}\n${p.device}`;

/** The devices that allowed this computer (each once), online ones first. */
export function remoteTargets(remote: RemoteState | null, now: number = Date.now()): RemoteTarget[] {
  if (!remote) return [];
  const out = new Map<string, RemoteTarget>();
  for (const p of remote.peers) {
    if (p.role !== "guest") continue;
    out.set(targetKey(p), { key: targetKey(p), account: p.account, device: p.device, name: p.name, presence: peerPresence(p, now) });
  }
  return [...out.values()].sort((a, b) => Number(b.presence === "online") - Number(a.presence === "online"));
}

/** The 「在这台电脑上 | 在别的设备上」 switch: only with remote on, logged in, and a device that allowed this computer. */
export const remoteModeShown = (remote: RemoteState | null): boolean => !!remote && remote.connection.state !== "off" && !!remote.account && remote.enabled && remoteTargets(remote).length > 0;

/** Why a device's offline chip cannot be picked. */
export const PRESENCE_TAG: Record<PeerPresence, string> = { online: "", lost: "刚失联", offline: "离线", unknown: "没连上服务器" };

/** What stops creating anything there, whatever is picked: nothing allowed on that computer. */
export function catalogProblem(c: RemoteCatalog): string | null {
  if (!c.projects.length && !c.allowCommon) return `${c.name} 还没勾远端允许的项目：在那台电脑的 远程 → 远程设置 里勾`;
  if (!c.models.length) return `${c.name} 还没勾远端允许的模型：在那台电脑的 远程 → 远程设置 里勾`;
  return null;
}

/** Ids by last use there, newest first (at most five): its 最近. */
const recent = (list: ReadonlyArray<{ id: string; lastUsed: string | null }>) =>
  [...list]
    .filter((x) => x.lastUsed)
    .sort((a, b) => b.lastUsed!.localeCompare(a.lastUsed!))
    .slice(0, 5)
    .map((x) => x.id);

export function catalogTopicChoices(c: RemoteCatalog): Choice[] {
  return rankChoices(c.topics, (t) => ({ id: t.id, name: t.title, hint: "" }), { recent: recent(c.topics) });
}

/** The projects there, the topic's own first (专题常用). */
export function catalogProjectChoices(c: RemoteCatalog, topicId: string | null): Choice[] {
  return rankChoices(c.projects, (p) => ({ id: p.id, name: p.name, hint: "" }), { topic: c.topics.find((t) => t.id === topicId)?.workspaceIds ?? [], recent: recent(c.projects) });
}

/** The project picked at first: the only one when the common folder is not allowed, else none. */
export const defaultProject = (c: RemoteCatalog): string | null => (!c.allowCommon && c.projects.length === 1 ? c.projects[0]!.id : null);
