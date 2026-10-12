import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ApprovalDecision, Session, SessionItem } from "@amo-studio/protocol";
import { Markdown } from "../lib/markdown.js";

type Approval = Extract<SessionItem, { type: "approval" }>;
type Tool = Extract<SessionItem, { type: "tool" }>;

interface ThreadProps {
  session: Session | null;
  items: readonly SessionItem[];
  model: string;
  busy: boolean;
  onApprove(item: Approval, decision: ApprovalDecision): void;
  onJump(sessionId: string): void;
  onSend(text: string): Promise<boolean>;
  onInterrupt(): void;
}

const APPROVAL_STATE: Record<Approval["state"], string> = {
  pending: "",
  accepted: "已批准",
  declined: "已拒绝",
  "resolved-elsewhere": "已在别处处理",
};
const TOOL_STATUS: Record<Tool["status"], string> = { running: "进行中", completed: "完成", failed: "失败", declined: "已拒绝" };

/** Conversation of one session plus its composer. */
export function Thread({ session, items, model, busy, onApprove, onJump, onSend, onInterrupt }: ThreadProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [draft, setDraft] = useState("");
  useEffect(() => setDraft(""), [session?.id]);

  // Keep following the bottom while new output arrives, unless the person scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const readOnly = !session || session.writer === "archived" || session.writer === "terminal-handoff";
  const generating = !!session && (session.status === "running" || session.status === "awaiting-approval");
  const placeholder = readOnly
    ? session?.writer === "archived"
      ? "已归档的会话只能查看，恢复后才能继续。"
      : "会话已交给终端，工作台暂时只读。"
    : generating
      ? "回复生成中，输入的内容会作为插话发出"
      : "继续推进这个会话，回车发送，Shift+回车换行";

  async function send() {
    const text = draft.trim();
    if (!text || readOnly) return;
    if (await onSend(text)) setDraft("");
  }

  return (
    <>
      <div
        className="thread"
        data-testid="thread"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!session && <div className="thread-empty">这个任务还没有会话。在左侧新建一个会话即可开始。</div>}
        {items.map((item) => (
          <ItemView key={item.id} item={item} model={model} busy={busy} onApprove={onApprove} onJump={onJump} />
        ))}
      </div>
      {session && (
        <div className="composer-dock">
          <label className="composer-input boxed">
            <span className="sr-only">输入消息</span>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={readOnly}
              rows={3}
              placeholder={placeholder}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
          </label>
          <div className="composer-bar">
            <span className="composer-hint">{generating && !readOnly ? "生成中：发送会插入到当前回合" : ""}</span>
            <span className="spacer" />
            {generating && !readOnly && (
              <button type="button" className="btn-ghost" onClick={onInterrupt}>
                打断
              </button>
            )}
            <button type="button" className="btn-primary" onClick={() => void send()} disabled={readOnly || !draft.trim()}>
              {generating ? "插话" : "发送"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function ItemView({ item, model, busy, onApprove, onJump }: { item: SessionItem; model: string; busy: boolean; onApprove: ThreadProps["onApprove"]; onJump: ThreadProps["onJump"] }) {
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
          <span className="msg-who">{model}</span>
          <Markdown source={item.markdown} />
          {item.streaming && <span className="streaming">生成中…</span>}
        </div>
      );
    case "tool":
      return <ToolCard item={item} />;
    case "approval":
      return (
        <div className={item.state === "pending" ? "approval pending" : "approval"} data-testid="approval" data-state={item.state}>
          <span className="approval-title">{item.kind === "command" ? "请求执行命令" : item.kind === "fileChange" ? "请求修改文件" : "请求更多权限"}</span>
          <code className="approval-detail">{item.summary}</code>
          {item.detail && <span className="approval-cwd">{item.detail}</span>}
          {item.state === "pending" ? (
            <div className="approval-actions">
              <button type="button" className="btn-attention" disabled={busy} onClick={() => onApprove(item, "accept")}>
                批准
              </button>
              <button type="button" className="btn-outline-attention" disabled={busy} onClick={() => onApprove(item, "decline")}>
                拒绝
              </button>
            </div>
          ) : (
            <span className="approval-result">{APPROVAL_STATE[item.state]}</span>
          )}
        </div>
      );
    case "subagent":
      return (
        <div className="subagent" data-testid="msg-subagent">
          <span className="dim">子 agent</span>
          <span>{item.summary}</span>
          <span className="spacer" />
          <button type="button" className="link-btn primary boxed" onClick={() => onJump(item.childSessionId)}>
            查看
          </button>
        </div>
      );
    case "error":
      return (
        <div className="msg-error" role="alert" data-testid="msg-error">
          {item.message}
        </div>
      );
    case "notice":
      return (
        <div className={item.level === "warning" ? "msg-notice warning" : "msg-notice"} data-testid="msg-notice">
          {item.message}
        </div>
      );
  }
}

function ToolCard({ item }: { item: Tool }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool" data-testid="tool" data-status={item.status}>
      <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{open ? "▾" : "▸"}</span>
        <span className="tool-name">{item.name}</span>
        <span className="tool-summary">{item.summary}</span>
        <span className="spacer" />
        <span className={`tool-status ${item.status}`}>{TOOL_STATUS[item.status]}</span>
      </button>
      {open && <pre className="tool-detail">{item.detail || "（没有输出）"}</pre>}
    </div>
  );
}
