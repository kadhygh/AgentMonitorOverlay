import { useState } from "react";
import { buildSessionTree, type ModelProfile, type Session, type SessionNode, type Task, type Workspace } from "@amo-studio/protocol";
import { defaultProfile, profileLabel, rememberProfile, shortModel } from "../lib/profiles.js";
import { SESSION_LOOK } from "../lib/status.js";

const KIND = { main: "会话", fork: "分支", sub: "子 agent" } as const;

interface SessionTreeProps {
  task: Task;
  sessions: readonly Session[];
  workspaces: readonly Workspace[];
  profiles: readonly ModelProfile[];
  selected: string | null;
  busy: boolean;
  onSelect(id: string): void;
  onNewSession(input: { profileId: string; workspaceId?: string }): void;
  onRestore(id: string): void;
  /** Unread mail per session id. */
  unread?: ReadonlyMap<string, number>;
  /** Session presets from the extension packs of the task's workspaces. */
  presets?: ReadonlyArray<{ key: string; label: string }>;
  onPreset?(key: string): void;
}

/** Left column of the task page: session tree (forks and subagents indented), new session, archived area. */
export function SessionTree({ task, sessions, workspaces, profiles, selected, busy, onSelect, onNewSession, onRestore, unread, presets = [], onPreset }: SessionTreeProps) {
  const isArea = task.scope.kind === "area";
  const live = sessions.filter((s) => !s.archivedAt);
  // An archived subtree shows once, by its top-most archived session.
  const archivedRoots = sessions.filter((s) => s.archivedAt && !sessions.some((p) => p.id === s.parentId && p.archivedAt));
  const [profileId, setProfileId] = useState(defaultProfile(profiles)?.id ?? "");
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [showArchived, setShowArchived] = useState(false);
  const profile = (id: string) => profiles.find((p) => p.id === id);
  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? "";

  const rows: Array<{ node: SessionNode; depth: number }> = [];
  const walk = (nodes: SessionNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth });
      walk(node.children, depth + 1);
    }
  };
  walk(buildSessionTree(live), 0);

  return (
    <aside className="session-list" aria-label="会话">
      <div className="nav-label">会话 {live.length}</div>
      {rows.map(({ node, depth }, idx) => {
        const s = node.session;
        const look = SESSION_LOOK[s.status];
        const letters = unread?.get(s.id) ?? 0;
        const kind = [KIND[s.kind], shortModel(profile(s.profileId)), isArea && s.kind === "main" ? wsName(s.workspaceId) : "", s.writer === "terminal-shared" ? "终端" : "", letters ? `${letters} 条留言` : ""]
          .filter(Boolean)
          .join(" · ");
        return (
          <button
            key={s.id}
            type="button"
            className="nav-row session-row"
            aria-current={s.id === selected}
            onClick={() => onSelect(s.id)}
            style={{ paddingLeft: 8 + depth * 16, marginTop: depth === 0 && idx > 0 ? 8 : 0 }}
            data-testid="session-row"
            data-kind={s.kind}
            data-depth={depth}
          >
            <span className="dot" style={{ background: look.dot }} title={look.label} />
            <span className="session-text">
              <span className="name">{s.title || "新会话"}</span>
              <span className="session-kind">{kind}</span>
            </span>
          </button>
        );
      })}

      <div className="new-session">
        <label className="stack-field">
          新会话模型
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {profileLabel(p)}
              </option>
            ))}
          </select>
        </label>
        {isArea && (
          <label className="stack-field">
            所在工作区
            <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="add-ws-toggle"
          disabled={busy || !profileId}
          onClick={() => {
            rememberProfile(profileId);
            onNewSession({ profileId, ...(isArea ? { workspaceId } : {}) });
          }}
        >
          + 新会话
        </button>
        {presets.length > 0 && onPreset && (
          <label className="stack-field">
            按预设
            <select value="" onChange={(e) => e.target.value && onPreset(e.target.value)} disabled={busy} aria-label="按预设新建会话">
              <option value="">选择启动预设…</option>
              {presets.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {archivedRoots.length > 0 && (
        <div className="archived">
          <button type="button" className="archived-toggle" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived}>
            {showArchived ? "▾" : "▸"} 已归档 {archivedRoots.length}
          </button>
          {showArchived &&
            archivedRoots.map((s) => (
              <div key={s.id} className="archived-row" data-testid="archived-row">
                <span className="name">{s.title || "会话"}</span>
                <button type="button" className="link-btn" onClick={() => onSelect(s.id)}>
                  查看
                </button>
                <button type="button" className="link-btn primary" onClick={() => onRestore(s.id)}>
                  恢复
                </button>
              </div>
            ))}
        </div>
      )}
    </aside>
  );
}
