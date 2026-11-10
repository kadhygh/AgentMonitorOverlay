import { useEffect, useMemo, useState } from "react";
import type { ForkRequest, ForkTurn, McpEntry, ModelProfile, Session } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import { activeModel, effortLabel, useProfileChoices } from "../lib/choices.js";
import { EffortBars, FastToggle, Mark, PermissionTiles } from "../chat/pickers.js";

// 分支 (2026-11-10, plans/done/session-fork.md; the look picked from plans/done/session-fork-dialog.html): from which turn, under
// the session or beside it, its title, and — folded until asked — the model of the same channel, effort, Fast,
// permissions and (Claude) MCP. Everything starts as the session has it.

type Mode = "sub" | "peer";

const defaultTitle = (session: Session, turn: ForkTurn | undefined) => `${session.title || "会话"} · ${turn ? `第 ${turn.n} 轮分支` : "分支"}`;

export function ForkDialog({ link, session, profile, turnId, onClose, onForked }: { link: HostLink; session: Session; profile: ModelProfile | undefined; turnId?: string; onClose(): void; onForked(s: Session): void }) {
  const [turns, setTurns] = useState<ForkTurn[] | null>(null);
  const [picked, setPicked] = useState<string | undefined>(turnId);
  const [mode, setMode] = useState<Mode>("sub");
  const [title, setTitle] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [model, setModel] = useState<string | null>(session.options.model ?? null);
  const [effort, setEffort] = useState<string | null>(session.options.effort ?? null);
  const [fast, setFast] = useState<boolean | undefined>(session.options.fast);
  const [permission, setPermission] = useState<string | null>(session.options.permission ?? null);
  const [mcp, setMcp] = useState<McpEntry[] | null>(null);
  const [mcpWant, setMcpWant] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { choices } = useProfileChoices(link, session.profileId);
  const claude = session.runtime === "claude";

  useEffect(() => {
    call(link, "GET /api/sessions/:id/fork-turns", { id: session.id })
      .then((list) => {
        setTurns(list);
        // From ⋯ (no turn given), or a turn that cannot be: the latest one that can.
        setPicked((t) => (list.some((x) => x.turnId === t && x.forkable) ? t : [...list].reverse().find((x) => x.forkable)?.turnId));
      })
      .catch((err: unknown) => setError(err instanceof HostApiError ? err.message : String(err)));
    // Codex's MCP is fixed when its app-server starts: a branch has the session's.
    if (claude)
      call(link, "GET /api/sessions/:id/mcp", { id: session.id })
        .then((s) => setMcp(s.entries))
        .catch(() => setMcp([]));
  }, [link, session.id, claude]);

  const turn = turns?.find((t) => t.turnId === picked);
  const current = useMemo(() => (choices ? activeModel(choices, { ...session.options, ...(model ? { model } : {}) }) : undefined), [choices, model, session.options]);
  const mcpOn = (e: McpEntry) => mcpWant[e.name] ?? e.on;
  const options: NonNullable<ForkRequest["options"]> = {
    ...(model !== (session.options.model ?? null) ? { model } : {}),
    ...(effort !== (session.options.effort ?? null) ? { effort } : {}),
    ...(fast !== session.options.fast ? { fast: fast ?? null } : {}),
    ...(permission !== (session.options.permission ?? null) ? { permission } : {}),
    ...(Object.keys(mcpWant).length ? { mcp: mcpWant } : {}),
  };
  const changed = Object.keys(options).length;
  const permissionLabel = choices?.permissions.find((p) => p.id === (permission ?? choices.defaultPermission))?.label ?? "默认权限";
  const summary = [current?.label ?? model ?? "默认型号", current?.efforts.length ? effortLabel(effort ?? current.defaultEffort ?? "") || "默认" : null, fast ? "Fast" : null, permissionLabel, mcp && claude ? `MCP ${mcp.filter(mcpOn).length} 个` : null].filter(Boolean).join(" · ");

  const pickModel = (id: string) => {
    setModel(id);
    const m = choices?.models.find((x) => x.id === id);
    if (m && effort && !m.efforts.includes(effort)) setEffort(null);
    if (m && !m.fast) setFast(undefined);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: ForkRequest = { ...(picked ? { turnId: picked } : {}), as: mode, ...(title !== null && title.trim() ? { title: title.trim() } : {}), ...(changed ? { options } : {}) };
      const s = await call(link, "POST /api/sessions/:id/fork", { id: session.id }, body);
      onForked(s);
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal className="fork-dialog" labelledBy="fork-dialog-title" testId="fork-dialog" busy={busy} onClose={onClose}>
      <div className="fork-head">
        <span className="modal-title" id="fork-dialog-title">
          分支
        </span>
        <span className="fork-from">从「{session.title || "会话"}」</span>
      </div>
      <div className="fork-field">
        <span className="fork-label">从哪轮</span>
        <div>
          <select className="fork-select" aria-label="从哪一轮分支" value={picked ?? ""} disabled={!turns?.length} onChange={(e) => setPicked(e.target.value)} data-testid="fork-turn">
            {!turns && <option value="">正在读取…</option>}
            {turns && !turns.length && <option value="">还没有对话</option>}
            {turns?.map((t) => (
              <option key={t.turnId} value={t.turnId} disabled={!t.forkable} title={t.why}>
                第 {t.n} 轮 · {t.prompt || "（没有文字）"}
                {t.forkable ? "" : `（${t.state === "running" ? "还在跑" : "不能选"}）`}
              </option>
            ))}
          </select>
          {turns && turn && (
            <span className="settings-hint">
              带上第 1 到第 {turn.n} 轮{turns.length > turn.n ? `，后面 ${turns.length - turn.n} 轮不带` : ""}
            </span>
          )}
          {claude && turns?.some((t) => !t.forkable && t.state !== "running") && <span className="settings-hint">灰掉的轮次是 Studio 开始记录分支位置之前跑的，只能从最新一轮分支。</span>}
        </div>
      </div>
      <div className="fork-field">
        <span className="fork-label">方式</span>
        <div>
          <div className="fork-seg" role="radiogroup" aria-label="方式">
            {(["sub", "peer"] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} data-testid={`fork-mode-${m}`}>
                {m === "sub" ? "子会话" : "平级会话"}
              </button>
            ))}
          </div>
          <span className="settings-hint">{mode === "sub" ? "挂在原会话下面，原会话归档时一起归档" : "和原会话并列，各自归档"}</span>
        </div>
      </div>
      <div className="fork-field">
        <span className="fork-label">标题</span>
        <input className="fork-input" aria-label="标题" value={title ?? defaultTitle(session, turn)} maxLength={100} onChange={(e) => setTitle(e.target.value)} data-testid="fork-title" />
      </div>
      <button type="button" className="fork-summary" aria-expanded={more} onClick={() => setMore((v) => !v)} data-testid="fork-more">
        <span className="fork-label">设置</span>
        <span className="fork-summary-text">
          {changed ? `改了 ${changed} 项：` : "和原会话一样："}
          {summary}
        </span>
        <span className="fork-summary-chev">{more ? "收起 ▴" : "改 ▾"}</span>
      </button>
      {more && choices && (
        <div className="fork-more">
          <div className="fork-sub">
            <span className="fork-label">模型</span>
            <div className="tray-row" role="group" aria-label="型号">
              {choices.models.map((m) => (
                <button key={m.id} type="button" className="mtile" aria-pressed={current?.id === m.id} title={m.description} onClick={() => pickModel(m.id)}>
                  <Mark profile={profile} small />
                  <span className="mtile-main">{m.label}</span>
                </button>
              ))}
            </div>
            <div className="fork-row">
              {current && current.efforts.length > 0 && <EffortBars efforts={current.efforts} value={effort} fallback={current.defaultEffort} onChange={setEffort} />}
              <FastToggle fast={current?.fast} value={fast} onChange={setFast} />
            </div>
            <span className="settings-hint">只列 {profile?.label ?? "这个渠道"} 的模型：分支不能换到别的渠道。</span>
          </div>
          <div className="fork-sub">
            <span className="fork-label">审批</span>
            <PermissionTiles choices={choices} value={permission} onChange={setPermission} />
          </div>
          <div className="fork-sub">
            <span className="fork-label">MCP</span>
            {claude ? (
              <div className="fork-mcp" role="group" aria-label="MCP">
                {mcp === null && <span className="settings-hint">正在读取…</span>}
                {mcp?.length === 0 && <span className="settings-hint">这个项目没有别的 MCP（Studio 自带的 amo 一直都在）。</span>}
                {mcp?.map((e) => (
                  <button
                    key={e.name}
                    type="button"
                    className="fork-chip"
                    aria-pressed={mcpOn(e)}
                    title={e.note ?? e.summary}
                    onClick={() => setMcpWant((w) => {
                      const next = { ...w };
                      if (!mcpOn(e) === e.on) delete next[e.name];
                      else next[e.name] = !mcpOn(e);
                      return next;
                    })}
                  >
                    {mcpOn(e) ? "✓" : "○"} {e.name}
                  </button>
                ))}
              </div>
            ) : (
              <span className="settings-hint">和原会话一样：Codex 的 MCP 跟着它的后台进程，分支时改不了。</span>
            )}
          </div>
        </div>
      )}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
      <div className="fork-actions">
        <span className="settings-hint">原会话不受影响</span>
        <span className="spacer" />
        <button type="button" className="btn-ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn-primary" disabled={busy || !turns || (turns.length > 0 && !turn?.forkable)} onClick={() => void submit()} data-testid="fork-submit">
          分支
        </button>
      </div>
    </Modal>
  );
}
