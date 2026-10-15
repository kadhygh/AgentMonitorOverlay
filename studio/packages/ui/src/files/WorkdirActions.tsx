import { HostApiError, type HostLink } from "../host/client.js";
import { openInEditor, revealInExplorer } from "../lib/openin.js";
import { useVsCode } from "./FileLinks.js";
import { shortFolder } from "./paths.js";

/**
 * The session's working directory in its header (stage 12, S12-C), with VS Code and Explorer next to it. `compact`
 * (2026-10-14): two icons only, the folder in their tooltips; drawn as the session bar's icon buttons (2026-10-15).
 */
export function WorkdirActions({ link, path, onError, compact }: { link: HostLink; path: string; onError?(text: string): void; compact?: boolean }) {
  const vscode = useVsCode(link);
  const fail = (err: unknown) => onError?.(err instanceof HostApiError ? err.message : String(err));
  if (compact)
    return (
      <span className="workdir compact" data-testid="workdir">
        {vscode && (
          <button type="button" className="bar-btn" aria-label="VS Code 打开文件夹" title={`VS Code 打开文件夹：${path}`} onClick={() => openInEditor(link, { path }).catch(fail)}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M11.2 1.8 14.2 3.3v9.4l-3 1.5L4.6 8z" />
              <path d="M11.2 1.8v12.4M4.6 8 2 6M4.6 8 2 10" />
            </svg>
          </button>
        )}
        <button type="button" className="bar-btn" aria-label="在资源管理器中显示" title={`在资源管理器中显示：${path}`} onClick={() => revealInExplorer(link, { path }).catch(fail)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M1.8 3.8h4.4l1.5 1.6h6.5v7.2H1.8z" />
          </svg>
        </button>
      </span>
    );
  return (
    <span className="workdir" data-testid="workdir">
      <span className="workdir-path" title={`工作目录：${path}`}>
        {shortFolder(path, 40)}
      </span>
      {vscode && (
        <button type="button" className="btn-ghost small dim" aria-label="VS Code 打开文件夹" title="VS Code 打开文件夹" onClick={() => openInEditor(link, { path }).catch(fail)}>
          VS Code
        </button>
      )}
      <button type="button" className="btn-ghost small dim" aria-label="在资源管理器中显示" title="在资源管理器中显示" onClick={() => revealInExplorer(link, { path }).catch(fail)}>
        资源管理器
      </button>
    </span>
  );
}
