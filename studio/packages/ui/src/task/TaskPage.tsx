import { useEffect, useState } from "react";
import type { ModelProfile, Session, SessionItem, Task, Workspace } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { useSessionItems } from "../host/useSessionItems.js";
import { shortModel } from "../lib/profiles.js";
import { SESSION_LOOK } from "../lib/status.js";

interface TaskPageProps {
  link: HostLink;
  task: Task;
  sessions: readonly Session[];
  workspaces: readonly Workspace[];
  profiles: readonly ModelProfile[];
  initialSessionId?: string;
  onBack(): void;
}

/** Task page skeleton: session list and the conversation of the selected session. S1-11 adds the full chat panel. */
export function TaskPage({ link, task, sessions, workspaces, profiles, initialSessionId, onBack }: TaskPageProps) {
  const own = sessions.filter((s) => s.taskId === task.id && !s.archivedAt);
  const [selected, setSelected] = useState<string | null>(initialSessionId ?? own[0]?.id ?? null);
  useEffect(() => {
    if (!selected && own[0]) setSelected(own[0].id);
  }, [selected, own]);
  const session = own.find((s) => s.id === selected) ?? null;
  const { items } = useSessionItems(link, session?.id ?? null);
  const profile = (id: string) => profiles.find((p) => p.id === id);
  const scope = task.scope.kind === "area" ? "跨工作区" : (workspaces.find((w) => w.id === (task.scope as { workspaceId: string }).workspaceId)?.name ?? "");

  return (
    <section className="taskpage" aria-label="任务">
      <div className="page-head">
        <button type="button" className="btn-ghost" onClick={onBack}>
          ← 看板
        </button>
        <h1 className="task-title" data-testid="task-title">
          {task.title || "未命名任务"}
        </h1>
        <span className="page-crumb">{scope}</span>
      </div>
      <div className="task-body">
        <aside className="session-list" aria-label="会话">
          <div className="nav-label">会话 {own.length}</div>
          {own.map((s) => {
            const look = SESSION_LOOK[s.status];
            return (
              <button key={s.id} type="button" className="nav-row session-row" aria-current={s.id === selected} onClick={() => setSelected(s.id)}>
                <span className="dot" style={{ background: look.dot }} />
                <span className="session-text">
                  <span className="name">{s.title || "新会话"}</span>
                  <span className="session-kind">{shortModel(profile(s.profileId))}</span>
                </span>
              </button>
            );
          })}
        </aside>
        <div className="thread" data-testid="thread">
          {!session && <div className="thread-empty">这个任务还没有会话。</div>}
          {items.map((item) => (
            <ItemView key={item.id} item={item} model={shortModel(session ? profile(session.profileId) : undefined)} />
          ))}
        </div>
      </div>
    </section>
  );
}

function ItemView({ item, model }: { item: SessionItem; model: string }) {
  switch (item.type) {
    case "user":
      return (
        <div className="msg-user" data-testid="msg-user">
          <span className="msg-who">你</span>
          <span className="msg-text">{item.text}</span>
        </div>
      );
    case "agent":
      return (
        <div className="msg-agent" data-testid="msg-agent">
          <span className="msg-who">
            {model}
            {item.streaming && <span className="streaming"> · 生成中…</span>}
          </span>
          <span className="msg-text">{item.markdown}</span>
        </div>
      );
    default:
      return (
        <div className="msg-other" data-testid={`msg-${item.type}`}>
          {item.type === "tool" ? `${item.name}: ${item.summary}` : item.type === "approval" ? `待批准：${item.summary}` : item.type === "error" ? item.message : item.type === "notice" ? item.message : item.summary}
        </div>
      );
  }
}
