import { HostApiError, type HostLink } from "../host/client.js";
import { openInEditor, revealInExplorer } from "../lib/openin.js";
import { useVsCode } from "./FileLinks.js";
import { shortFolder } from "./paths.js";

/** The session's working directory in its header (stage 12, S12-C), with VS Code and Explorer next to it. */
export function WorkdirActions({ link, path, onError }: { link: HostLink; path: string; onError?(text: string): void }) {
  const vscode = useVsCode(link);
  const fail = (err: unknown) => onError?.(err instanceof HostApiError ? err.message : String(err));
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
