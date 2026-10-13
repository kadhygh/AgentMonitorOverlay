import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import type { GitChangedFile } from "@amo-studio/protocol";
import { buildTree, clampWidth, LIST_WIDTH, splitFolder, splitName, treeRows, type ListLayout } from "./filetree.js";
import { groupByFolder, STATUS_LETTER, STATUS_NAME } from "./logic.js";

// The review window's file list (S12-A): a folder tree (default) or a flat list, names that never get cut at the
// end, the splitter that sizes the list, and the right-click menu of a file.

interface FileListProps {
  files: readonly GitChangedFile[];
  layout: ListLayout;
  selected: string | null;
  /** Draft comments per path. */
  perFile: ReadonlyMap<string, number>;
  /** Folded folders (tree paths). */
  closed: ReadonlySet<string>;
  onToggle(folder: string): void;
  onSelect(path: string): void;
  onMenu(file: GitChangedFile, x: number, y: number): void;
}

/** A name with a middle ellipsis: the head shrinks, the tail (end of the name and extension) always shows. */
export function MiddleName({ text, split = splitName, className = "gr-name" }: { text: string; split?: (s: string) => { head: string; tail: string }; className?: string }) {
  const { head, tail } = split(text);
  return (
    <span className={className}>
      {head && <span className="gr-name-head">{head}</span>}
      <span className="gr-name-tail">{tail}</span>
    </span>
  );
}

const fileTitle = (f: GitChangedFile) => (f.oldPath ? `${f.oldPath} → ${f.path}` : f.path);

export function FileList({ files, layout, selected, perFile, closed, onToggle, onSelect, onMenu }: FileListProps) {
  const tree = useMemo(() => (layout === "tree" ? buildTree(files) : null), [files, layout]);
  const rows = useMemo(() => (tree ? treeRows(tree, closed) : []), [tree, closed]);
  const flat = useMemo(() => (layout === "flat" ? groupByFolder(files).flatMap((g) => g.files.map((f) => ({ ...f, folder: g.folder }))) : []), [files, layout]);

  const fileRow = (f: GitChangedFile, name: string, depth: number | null, folder?: string) => (
    <button
      key={f.path}
      type="button"
      className={depth === null ? "gr-file flat" : "gr-file"}
      style={depth === null ? undefined : { paddingLeft: 6 + depth * 14 + 14 }}
      aria-current={f.path === selected}
      onClick={() => onSelect(f.path)}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        onSelect(f.path);
        onMenu(f, e.clientX, e.clientY);
      }}
      title={fileTitle(f)}
      data-testid="review-file"
    >
      <span className={`gr-status ${f.status}${f.untracked ? " untracked" : ""}`} title={f.untracked ? "未跟踪的新文件" : STATUS_NAME[f.status]}>
        {STATUS_LETTER[f.status]}
      </span>
      {depth === null ? (
        <span className="gr-flat-names">
          <MiddleName text={name} />
          {folder ? <MiddleName text={folder} split={splitFolder} className="gr-name gr-name-folder" /> : null}
        </span>
      ) : (
        <MiddleName text={name} />
      )}
      {perFile.get(f.path) ? <span className="gr-badge">{perFile.get(f.path)}</span> : null}
      <span className="gr-count">
        {f.binary ? (
          "二进制"
        ) : (
          <>
            <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
          </>
        )}
      </span>
    </button>
  );

  if (layout === "flat") return <>{flat.map((f) => fileRow(f.file, f.name, null, f.folder))}</>;
  return (
    <>
      {rows.map((r) =>
        r.kind === "file" ? (
          fileRow(r.file, r.name, r.depth)
        ) : (
          <button
            key={r.key}
            type="button"
            className="gr-dir"
            style={{ paddingLeft: 6 + r.depth * 14 }}
            aria-expanded={r.open}
            onClick={() => onToggle(r.folder.path)}
            title={r.folder.path}
            data-testid="review-folder"
          >
            <span className="gr-chev" aria-hidden="true">
              {r.open ? "▾" : "▸"}
            </span>
            <MiddleName text={r.folder.name} split={splitFolder} />
            <span className="gr-dir-count">{r.folder.count}</span>
          </button>
        ),
      )}
    </>
  );
}

/** The bar between the file list and the diff: drag (or ← / →) to size the list, double-click to reset. */
export function Splitter({ width, onChange }: { width: number; onChange(width: number): void }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      className="gr-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="文件列表宽度"
      aria-valuemin={LIST_WIDTH.min}
      aria-valuemax={LIST_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      title="拖动调整文件列表宽度，双击恢复"
      data-testid="review-splitter"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width };
      }}
      onPointerMove={(e) => drag.current && onChange(clampWidth(drag.current.width + e.clientX - drag.current.x))}
      onPointerUp={() => (drag.current = null)}
      onLostPointerCapture={() => (drag.current = null)}
      onDoubleClick={() => onChange(LIST_WIDTH.initial)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        e.stopPropagation();
        onChange(clampWidth(width + (e.key === "ArrowLeft" ? -16 : 16)));
      }}
    />
  );
}

export interface FileMenuAt {
  file: GitChangedFile;
  x: number;
  y: number;
}

/** Right-click menu of a file row: VS Code (when the machine has it) and Explorer; a deleted file has neither. */
export function FileMenu({ at, vscode, onOpen, onClose }: { at: FileMenuAt; vscode: boolean; onOpen(app: "vscode" | "explorer"): void; onClose(): void }) {
  // Closes on Escape and on any click outside it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: globalThis.MouseEvent) => !(e.target as Element | null)?.closest?.(".ctx-menu") && onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
  const gone = at.file.status === "deleted";
  const item = (app: "vscode" | "explorer", label: string) => (
    <button
      type="button"
      role="menuitem"
      disabled={gone}
      title={gone ? "文件已删除" : undefined}
      onClick={() => {
        onOpen(app);
        onClose();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="ctx-menu" role="menu" aria-label="文件" style={{ left: Math.min(at.x, window.innerWidth - 200), top: Math.min(at.y, window.innerHeight - 90) }}>
      {vscode && item("vscode", "VS Code 打开")}
      {item("explorer", "在资源管理器中显示")}
    </div>
  );
}
