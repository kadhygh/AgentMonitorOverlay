import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { onHostEvent } from "../host/events.js";

// Keeps a rendering failure to the part that failed (one conversation row, one turn, one page, one window) instead of
// a blank window: that part says what went wrong and can try again; the details go to the console.

interface Props {
  children: ReactNode;
  fallback(error: Error, retry: () => void): ReactNode;
  /** Another value starts over (a different page or session). */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
  key: unknown;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.key) ? null : { error: null, key: props.resetKey };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("AMO Studio: a view failed to render", error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error, () => this.setState({ error: null })) : this.props.children;
  }
}

const firstLine = (e: Error) => (e.message || String(e)).split(/\r?\n/)[0]!.slice(0, 200);

/** One conversation row or turn: the rest of the conversation stays. */
export function RowBoundary({ children, what = "这一条" }: { children: ReactNode; what?: string }) {
  return (
    <ErrorBoundary
      fallback={(e, retry) => (
        <div className="render-error" role="alert" data-testid="render-error">
          <span>
            {what}显示不了：{firstLine(e)}
          </span>
          <button type="button" className="link-btn" onClick={retry}>
            重试
          </button>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

/** A page or panel: the window around it stays usable. */
export function PaneBoundary({ children, resetKey }: { children: ReactNode; resetKey?: unknown }) {
  return (
    <ErrorBoundary
      resetKey={resetKey}
      fallback={(e, retry) => (
        <div className="render-error pane" role="alert" data-testid="render-error">
          <strong>这里出错了，其他部分和会话不受影响。</strong>
          <span>{firstLine(e)}</span>
          <div className="render-error-actions">
            <button type="button" className="btn-ghost small" onClick={retry}>
              重试
            </button>
            <button type="button" className="btn-ghost small" onClick={() => location.reload()}>
              重新载入窗口
            </button>
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

/** The whole window (the last resort): sessions keep running in the Host either way. */
export function WindowBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={(e) => (
        <div className="render-error window" role="alert" data-testid="render-error">
          <strong>这个窗口出错了。</strong>
          <span>{firstLine(e)}</span>
          <span className="render-error-note">会话在后台照常运行，重新载入窗口即可回来。</span>
          <button type="button" className="btn-primary" onClick={() => location.reload()}>
            重新载入窗口
          </button>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

/**
 * Errors the Host caught outside any request (it keeps running), and a Host the shell had to start again: shown as a
 * toast, the latest one.
 */
export function HostErrorToast() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => onHostEvent((e) => e.type === "host.error" && setMessage(`Host 内部出错，已记录到 host.log，会话照常运行：${e.message}`)), []);
  useEffect(() => window.amo?.onHostRestarted?.(() => setMessage("Host 意外退出，已自动重新启动。Codex 会话会接着运行；Claude 会话正在进行的回复被中断了，发一条消息即可继续。")), []);
  if (!message) return null;
  return (
    <div role="status" className="toast toast-error host-error-toast" data-testid="host-error">
      <span>{message}</span>
      <button type="button" className="toast-close" aria-label="关闭提示" onClick={() => setMessage(null)}>
        ×
      </button>
    </div>
  );
}
