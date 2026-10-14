import { HostApiError, type HostLink } from "../host/client.js";
import { openInEditor, revealInExplorer } from "../lib/openin.js";
import { useVsCode } from "./FileLinks.js";
import { shortFolder } from "./paths.js";

/**
 * The session's working directory in its header (stage 12, S12-C), with VS Code and Explorer next to it. `compact`
 * (2026-10-14): two icons only, the folder in their tooltips.
 */
export function WorkdirActions({ link, path, onError, compact }: { link: HostLink; path: string; onError?(text: string): void; compact?: boolean }) {
  const vscode = useVsCode(link);
  const fail = (err: unknown) => onError?.(err instanceof HostApiError ? err.message : String(err));
  if (compact)
    return (
      <span className="workdir compact" data-testid="workdir">
        {vscode && (
          <button type="button" className="btn-ghost small icon-only" aria-label="VS Code 打开文件夹" title={`VS Code 打开文件夹：${path}`} onClick={() => openInEditor(link, { path }).catch(fail)}>
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path d="m11 2 3 1.5v9L11 14 4 8l7-6zM2 6l2 2-2 2" />
            </svg>
          </button>
        )}
        <button type="button" className="btn-ghost small icon-only" aria-label="在资源管理器中显示" title={`在资源管理器中显示：${path}`} onClick={() => revealInExplorer(link, { path }).catch(fail)}>
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />
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
