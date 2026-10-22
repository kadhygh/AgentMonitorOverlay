import { useEffect, useState, type JSX } from "react";
import { buildSessionTree, type ModelProfile, type Session, type SessionNode, type SessionOptions, type Task, type Workspace } from "@amo-studio/protocol";
import { defaultProfile, rememberProfile, shortModel } from "../lib/profiles.js";
import { sessionModelName, storedChoices } from "../lib/choices.js";
import type { HostLink } from "../host/client.js";
import { activeModel, useProfileChoices } from "../lib/choices.js";
import { rememberPick, type ModelPick } from "../lib/recents.js";
import { EffortBars, FastToggle } from "../chat/pickers.js";
import { ModelRow } from "../newtask/ModelRow.js";
import { useDragWidth } from "../lib/dragWidth.js";
import { needsPerson, relativeTime, SESSION_LOOK } from "../lib/status.js";
import { wakeLabel } from "../chat/WakeBar.js";
import { Mark } from "../chat/pickers.js";
import { ArchiveIcon, formatDay } from "./Archived.js";
import { useStoredIds } from "../lib/storedIds.js";

const KIND = { main: "会话", fork: "分支", sub: "子 agent" } as const;

/**
 * 委派 (2026-10-22): a main session another session of the task started (session_start). The list shows it under that
 * one, like a subagent, with its own icon; it is archived on its own.
 */
const delegatedBy = (s: Session, all: readonly Session[]): Session | undefined =>
  s.parentId || !s.startedBy ? undefined : all.find((x) => x.id === s.startedBy);

/** The session a row hangs under in the list: its parent, or the one that started it. */
const listParent = (s: Session): string | null => s.parentId ?? s.startedBy ?? null;

const kindText = (s: Session, all: readonly Session[]): string => (delegatedBy(s, all) ? "委派会话" : s.kind === "main" ? "" : KIND[s.kind]);

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
  /** The new-session form, opened from 新会话 in the task head (2026-10-14). */
  creating: boolean;
  onCreating(open: boolean): void;
}

/** Left column of the task page: session tree (forks and subagents indented), new session, archived area. Shown or hidden as a whole by 会话 in the task head (2026-10-15). */
export function SessionTree({ link, task, sessions, workspaces, profiles, selected, busy, onSelect, onNewSession, onRestore, unread, presets = [], onPreset, creating, onCreating }: SessionTreeProps) {
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
  // The list's width, dragged at its right edge (2026-10-15).
  const listW = useDragWidth("amo.sessionListWidth", 236, 180, 480);
  // An archived session brought to the front (from search, Focus, or an archived task) shows its row. Only on a change
  // of selection: archiving the session in front leaves the folded list alone.
  const selectedArchived = sessions.some((s) => s.id === selected && s.archivedAt);
  useEffect(() => {
    if (selectedArchived) setShowArchived(true);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  // The new-session form opens on demand (and when the task has no live session yet).
  const setCreating = (v: boolean) => onCreating(v);
  // An archived task takes no new sessions (stage 14): its banner restores it first.
  const closed = !!task.archivedAt;
  const formOpen = !closed && (creating || live.length === 0);
  const profile = (id: string) => profiles.find((p) => p.id === id);

  // Folded sessions (10-22): their subagents, forks and 委派 sessions hide under「▸ N」, remembered per machine. A
  // session selected inside a folded one (from Focus, search, a link) opens the way to it.
  const folded = useStoredIds(TREE_FOLDED_KEY);
  useEffect(() => {
    const seen = new Set<string>();
    for (let s = live.find((x) => x.id === selected); s && !seen.has(s.id); s = live.find((x) => x.id === listParent(s!))) {
      seen.add(s.id);
      const up = listParent(s);
      if (up && folded.has(up)) folded.toggle(up);
    }
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const tree = buildSessionTree(live, { delegated: true });
  // The model by name when known ("Opus 5.5"), from the last list this install saw.
  const modelOf = (s: Session) => {
    const p = profile(s.profileId);
    return (p && sessionModelName(storedChoices(p.id), s.options)) || shortModel(p);
  };
  const selectedLive = live.find((s) => s.id === selected) ?? null;

  return (
    <>
    <aside className="session-list" aria-label="会话" style={{ flexBasis: listW.width }}>
      <div className="slist-head">
        <span className="nav-label">会话 {live.length}</span>
        {formOpen && live.length > 0 && (
          <button type="button" className="btn-ghost small" onClick={() => setCreating(false)}>
            收起
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

      <div className="slist tree" role="tree" aria-label="会话树">
        <TreeLevel nodes={tree} all={live} depth={0} parentProfile={null} selected={selected} unread={unread} profileOf={profile} onSelect={onSelect} modelOf={modelOf} folded={folded} />
      </div>
      {selectedLive && <SessionDetail session={selectedLive} all={live} model={modelOf(selectedLive)} letters={unread?.get(selectedLive.id) ?? 0} />}

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
              const meta = [kindText(s, sessions), modelText].filter(Boolean).join(" · ");
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
    {listW.handle("调整会话列表宽度")}
    </>
  );
}

/** Beyond this depth the tree stops moving right (its lines still show the nesting), so titles keep their room. */
const MAX_INDENT = 4;

export const TREE_FOLDED_KEY = "amo.sessionTreeFolded";

/** Everything that hangs under a session, at any depth. */
const below = (node: SessionNode): Session[] => node.children.flatMap((c) => [c.session, ...below(c)]);

const TREE_ICON: Record<Session["kind"], JSX.Element> = {
  main: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11a1 1 0 0 1-1-1z" />
    </svg>
  ),
  sub: (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="5" width="9" height="7.5" rx="2" />
      <path d="M8 5V3M6.3 8.5h.01M9.7 8.5h.01" />
    </svg>
  ),
  fork: (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="5" cy="4" r="1.5" />
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="11" cy="6" r="1.5" />
      <path d="M5 5.5v5M11 7.5c0 2-3 2-5.5 3" />
    </svg>
  ),
};

/** 委派会话: an arrow turning down and on, handed over from the session above. */
const DELEGATED_ICON = (
  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3.5 3v3.5A2.5 2.5 0 0 0 6 9h7" />
    <path d="M10.5 6.5 13 9l-2.5 2.5" />
  </svg>
);

/**
 * One level of the session tree (2026-10-15, design B 「细线树」): each session one line — what it is (会话 / 子 agent /
 * 分支 / 委派会话), its name, its model where it differs from its parent's, and its state (a dot, or a word when it needs the
 * person). Children hang under it on their own thin line, to any depth.
 */
function TreeLevel({
  nodes,
  all,
  depth,
  parentProfile,
  selected,
  unread,
  profileOf,
  onSelect,
  modelOf,
  folded,
}: {
  nodes: readonly SessionNode[];
  all: readonly Session[];
  depth: number;
  parentProfile: string | null;
  selected: string | null;
  unread: ReadonlyMap<string, number> | undefined;
  profileOf(id: string): ModelProfile | undefined;
  onSelect(id: string): void;
  modelOf(s: Session): string;
  folded: { has(id: string): boolean; toggle(id: string): void };
}) {
  return (
    <>
      {nodes.map((node) => {
        const s = node.session;
        const look = SESSION_LOOK[s.status];
        const letters = unread?.get(s.id) ?? 0;
        const loud = needsPerson(s.status) || s.status === "error";
        const terminal = s.writer === "terminal-shared";
        const hidden = below(node);
        const open = !folded.has(s.id);
        // Folded, it still says when something under it needs the person.
        const alert = !open && hidden.some((x) => needsPerson(x.status) || x.status === "error");
        const starter = delegatedBy(s, all);
        const kind = starter ? "委派会话" : KIND[s.kind];
        return (
          <div key={s.id} className="tree-node" role="none">
            <div className="tree-line">
              <button
                type="button"
                role="treeitem"
                className={depth > 0 ? "srow tree-row child" : "srow tree-row"}
                aria-current={s.id === selected}
                aria-level={depth + 1}
                title={[s.title || "新会话", [kind, modelOf(s), look.label, relativeTime(s.updatedAt)].join(" · "), starter ? `由「${starter.title || "新会话"}」开的，单独归档` : ""].filter(Boolean).join("\n")}
                onClick={() => onSelect(s.id)}
                data-testid="session-row"
                data-kind={s.kind}
                data-delegated={starter ? true : undefined}
                data-depth={depth}
              >
                <span className="tree-icon">{starter ? DELEGATED_ICON : TREE_ICON[s.kind]}</span>
                <span className="srow-title">{s.title || "新会话"}</span>
                {letters > 0 && (
                  <span className="srow-mail" aria-label={`${letters} 条留言`} title={`${letters} 条留言`} data-testid="session-mail">
                    {letters}
                  </span>
                )}
                {terminal && (
                  <span className="tree-term" aria-label="终端已接入" title="终端已接入">
                    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                      <rect x="2" y="3" width="12" height="10" rx="1.5" />
                      <path d="M5 7l2 1.5L5 10M8.5 10.5H11" />
                    </svg>
                  </span>
                )}
                {s.profileId !== parentProfile && <Mark profile={profileOf(s.profileId)} small />}
                {s.wake && (s.wake.loop || s.wake.limit) && (
                  <span className="tree-wake" data-kind={s.wake.limit ? "limit" : "loop"} data-testid="session-wake">
                    {wakeLabel(s.wake)}
                  </span>
                )}
                {loud ? (
                  <span className="tree-badge" style={{ color: look.text }}>
                    {look.label}
                  </span>
                ) : (
                  <span className={`tree-dot ${s.status}`} style={{ background: s.status === "completed" ? "transparent" : look.dot }} title={look.label} aria-label={look.label} />
                )}
              </button>
              {hidden.length > 0 && (
                <button
                  type="button"
                  className="tree-fold"
                  aria-expanded={open}
                  aria-label={open ? `收起下面的 ${hidden.length} 个会话` : `展开下面的 ${hidden.length} 个会话`}
                  title={open ? "收起下面的子 agent、分支和委派会话" : alert ? "下面有会话等你处理，展开看" : "展开下面的子 agent、分支和委派会话"}
                  data-alert={alert || undefined}
                  onClick={() => folded.toggle(s.id)}
                  data-testid="session-fold"
                >
                  {open ? "▾" : "▸"} {hidden.length}
                </button>
              )}
            </div>
            {open && node.children.length > 0 && (
              <div className={depth + 1 >= MAX_INDENT ? "tree-children flat" : "tree-children"} role="group">
                <TreeLevel nodes={node.children} all={all} depth={depth + 1} parentProfile={s.profileId} selected={selected} unread={unread} profileOf={profileOf} onSelect={onSelect} modelOf={modelOf} folded={folded} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Under the tree: the selected session in words — what it is, model, state, when, and what hangs under it. */
function SessionDetail({ session: s, all, model, letters }: { session: Session; all: readonly Session[]; model: string; letters: number }) {
  const look = SESSION_LOOK[s.status];
  const under = (id: string): Session[] => all.filter((x) => listParent(x) === id).flatMap((x) => [x, ...under(x.id)]);
  const below = under(s.id);
  const subs = below.filter((x) => x.kind === "sub");
  const forks = below.filter((x) => x.kind === "fork");
  const delegated = below.filter((x) => delegatedBy(x, all));
  const starter = delegatedBy(s, all);
  const parts = [
    subs.length ? `${subs.length} 个子 agent${subs.some((x) => x.status === "running") ? `（${subs.filter((x) => x.status === "running").length} 个在运行）` : ""}` : "",
    forks.length ? `${forks.length} 个分支` : "",
    delegated.length ? `${delegated.length} 个委派会话` : "",
    below.some((x) => needsPerson(x.status)) ? `${below.filter((x) => needsPerson(x.status)).length} 个等你处理` : "",
  ].filter(Boolean);
  return (
    <div className="slist-detail" data-testid="session-detail">
      <span className="slist-detail-title">{s.title || "新会话"}</span>
      <span>
        {[kindText(s, all), model].filter(Boolean).join(" · ")} · <span style={{ color: look.text }}>{look.label}</span> · {relativeTime(s.updatedAt)}
      </span>
      {starter && <span>由「{starter.title || "新会话"}」开的</span>}
      {parts.length > 0 && <span>{parts.join(" · ")}</span>}
      {(letters > 0 || s.writer === "terminal-shared") && <span>{[letters > 0 ? `${letters} 条留言` : "", s.writer === "terminal-shared" ? "终端已接入" : ""].filter(Boolean).join(" · ")}</span>}
    </div>
  );
}

/** The chevron of the fold buttons (左栏, 会话列表). */
export function FoldIcon({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="fold-icon">
      <path d={dir === "left" ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"} />
    </svg>
  );
}
