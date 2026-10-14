import { useEffect, useState } from "react";
import { buildSessionTree, type ModelProfile, type Session, type SessionNode, type SessionOptions, type Task, type Workspace } from "@amo-studio/protocol";
import { defaultProfile, rememberProfile, shortModel } from "../lib/profiles.js";
import { sessionModelName, storedChoices } from "../lib/choices.js";
import type { HostLink } from "../host/client.js";
import { activeModel, useProfileChoices } from "../lib/choices.js";
import { rememberPick, type ModelPick } from "../lib/recents.js";
import { EffortBars, FastToggle } from "../chat/pickers.js";
import { ModelRow } from "../newtask/ModelRow.js";
import { relativeTime, SESSION_LOOK } from "../lib/status.js";
import { Mark } from "../chat/pickers.js";
import { ArchiveIcon, formatDay } from "./Archived.js";

const KIND = { main: "会话", fork: "分支", sub: "子 agent" } as const;

interface SessionTreeProps {
  task: Task;
  sessions: readonly Session[];
  workspaces: readonly Workspace[];
  profiles: readonly ModelProfile[];
  selected: string | null;
  busy: boolean;
  onSelect(id: string): void;
  onNewSession(input: { profileId: string; options?: SessionOptions }): void;
  link: HostLink;
  onRestore(id: string): void;
  /** Unread mail per session id. */
  unread?: ReadonlyMap<string, number>;
  /** Session presets from the extension packs of the task's workspaces. */
  presets?: ReadonlyArray<{ key: string; label: string }>;
  onPreset?(key: string): void;
}

/** Left column of the task page: session tree (forks and subagents indented), new session, archived area. */
export function SessionTree({ link, task, sessions, workspaces, profiles, selected, busy, onSelect, onNewSession, onRestore, unread, presets = [], onPreset }: SessionTreeProps) {
  const live = sessions.filter((s) => !s.archivedAt);
  // An archived subtree shows once, by its top-most archived session.
  const archivedRoots = sessions.filter((s) => s.archivedAt && !sessions.some((p) => p.id === s.parentId && p.archivedAt));
  const [pick, setPick] = useState<ModelPick>({ profileId: defaultProfile(profiles)?.id ?? "", model: null });
  const [effort, setEffort] = useState<string | null>(null);
  const [fast, setFast] = useState<boolean | undefined>(undefined);
  const [drawer, setDrawer] = useState(false);
  const { choices } = useProfileChoices(link, pick.profileId);
  const model = choices ? activeModel(choices, pick.model ? { model: pick.model } : {}) : undefined;
  const [showArchived, setShowArchived] = useState(false);
  // An archived session brought to the front (from search, Focus, or an archived task) shows its row. Only on a change
  // of selection: archiving the session in front leaves the folded list alone.
  const selectedArchived = sessions.some((s) => s.id === selected && s.archivedAt);
  useEffect(() => {
    if (selectedArchived) setShowArchived(true);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  // The new-session form opens on demand (and when the task has no live session yet).
  const [creating, setCreating] = useState(false);
  // An archived task takes no new sessions (stage 14): its banner restores it first.
  const closed = !!task.archivedAt;
  const formOpen = !closed && (creating || live.length === 0);
  const profile = (id: string) => profiles.find((p) => p.id === id);

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
      <div className="slist-head">
        <span className="nav-label">会话 {live.length}</span>
        {!closed && (
          <button type="button" className="btn-ghost small" aria-expanded={formOpen} onClick={() => setCreating((v) => !v)} data-testid="new-session-toggle">
            {formOpen && live.length > 0 ? "收起" : "+ 新会话"}
          </button>
        )}
      </div>

      {formOpen && (
        <div className="new-session" aria-label="新会话">
          <ModelRow
            link={link}
            profiles={profiles}
            pick={pick}
            onPick={(next) => {
              setPick(next);
              setEffort(null);
              setFast(undefined);
            }}
            drawer={drawer}
            onToggleDrawer={() => setDrawer((v) => !v)}
            small
          />
          {model && model.efforts.length > 0 && <EffortBars efforts={model.efforts} value={effort} fallback={model.defaultEffort} onChange={setEffort} small />}
          <FastToggle fast={model?.fast} value={fast} onChange={setFast} small />
          <button
            type="button"
            className="btn-primary small"
            disabled={busy || !pick.profileId}
            onClick={() => {
              rememberProfile(pick.profileId);
              rememberPick(pick);
              const options: SessionOptions = { ...(pick.model ? { model: pick.model } : {}), ...(effort ? { effort } : {}), ...(fast !== undefined && model?.fast ? { fast } : {}) };
              onNewSession({ profileId: pick.profileId, ...(Object.keys(options).length ? { options } : {}) });
              setCreating(false);
            }}
          >
            开始新会话
          </button>
          {presets.length > 0 && onPreset && (
            <label className="stack-field">
              按扩展包预设
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
      )}

      <div className="slist">
        {rows.map(({ node, depth }) => {
          const s = node.session;
          const look = SESSION_LOOK[s.status];
          const letters = unread?.get(s.id) ?? 0;
          const p = profile(s.profileId);
          // The model by name when known ("Opus 5.5"), from the last list this install saw.
          const modelText = (p && sessionModelName(storedChoices(p.id), s.options)) || shortModel(p);
          const meta = [s.kind === "main" ? "" : KIND[s.kind], modelText, look.label, s.writer === "terminal-shared" ? "终端已接入" : ""].filter(Boolean).join(" · ");
          return (
            <button
              key={s.id}
              type="button"
              className={depth > 0 ? "srow child" : "srow"}
              aria-current={s.id === selected}
              onClick={() => onSelect(s.id)}
              style={{ marginLeft: depth * 14 }}
              data-testid="session-row"
              data-kind={s.kind}
              data-depth={depth}
            >
              <span className="srow-top">
                <span className="dot" style={{ background: look.dot }} title={look.label} />
                <span className="srow-title">{s.title || "新会话"}</span>
                <span className="srow-time">{relativeTime(s.updatedAt)}</span>
              </span>
              <span className="srow-meta">
                <Mark profile={p} small />
                <span className="srow-meta-text">{meta}</span>
                {letters > 0 && <span className="srow-mail">{letters} 条留言</span>}
              </span>
            </button>
          );
        })}
      </div>

      {archivedRoots.length > 0 && (
        <div className="archived">
          <button type="button" className="archived-toggle" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived} data-testid="archived-toggle">
            <span className="archived-caret" aria-hidden="true">
              {showArchived ? "▾" : "▸"}
            </span>
            <ArchiveIcon size={14} />
            已归档 {archivedRoots.length}
          </button>
          {showArchived &&
            archivedRoots.map((s) => {
              const p = profile(s.profileId);
              const modelText = (p && sessionModelName(storedChoices(p.id), s.options)) || shortModel(p);
              const meta = [s.kind === "main" ? "" : KIND[s.kind], modelText].filter(Boolean).join(" · ");
              return (
                <div key={s.id} className="srow archived-srow" aria-current={s.id === selected} data-testid="archived-row">
                  <button
                    type="button"
                    className="srow-open"
                    onClick={() => onSelect(s.id)}
                    title={`查看这个已归档的会话（只读）${s.archivedAt ? `
${formatDay(s.archivedAt)} 归档` : ""}`}
                  >
                    <span className="srow-top">
                      <ArchiveIcon size={13} />
                      <span className="srow-title">{s.title || "新会话"}</span>
                      <span className="srow-time">{relativeTime(s.archivedAt ?? s.updatedAt)}</span>
                    </span>
                    <span className="srow-meta">
                      <Mark profile={p} small />
                      <span className="srow-meta-text">{[meta, "已归档"].filter(Boolean).join(" · ")}</span>
                    </span>
                  </button>
                  <span className="srow-actions">
                    <button type="button" className="link-btn" onClick={() => onSelect(s.id)}>
                      查看
                    </button>
                    <button type="button" className="link-btn primary" disabled={busy} onClick={() => onRestore(s.id)}>
                      恢复
                    </button>
                  </span>
                </div>
              );
            })}
        </div>
      )}
    </aside>
  );
}
