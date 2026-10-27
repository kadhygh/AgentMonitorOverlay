import { useEffect, useLayoutEffect, useMemo, useRef, type MouseEvent } from "react";
import type { GitChangedFile } from "@amo-studio/protocol";
import { FileTypeIcon } from "../files/FileTypeIcon.js";
import { buildTree, clampWidth, LIST_WIDTH, splitFolder, splitName, splitPath, treeRows, type ListLayout } from "./filetree.js";
import { LazyChunks } from "./LazyChunks.js";
import { isWebPage } from "../lib/openin.js";
import { listOrder, STATUS_GLYPH, STATUS_NAME } from "./logic.js";

// The review window's file list: a flat list of full paths (default, after Fork) or a folder tree (S12-A), each file
// with its status icon and type icon, names that never get cut at the end, the splitter that sizes the list, and the
// right-click menu of a file.

interface FileListProps {
  files: readonly GitChangedFile[];
  layout: ListLayout;
  selected: string | null;
  /** A viewer can keep its changes view mounted while showing the file; reveal only when in front. */
  active?: boolean;
  /** Draft comments per path. */
  perFile: ReadonlyMap<string, number>;
  /** Folded folders (tree paths). */
  closed: ReadonlySet<string>;
  onToggle(folder: string): void;
  onSelect(path: string): void;
  /** The pointer rests on a file (its diff is read ahead). */
  onHover?(file: GitChangedFile): void;
  onMenu(file: GitChangedFile, x: number, y: number): void;
  /** Two lists on one page (查看包: the files pointed at, then the rest) keep apart. */
  group?: string;
}

/** A file's status as a coloured square, as in Fork: + added, M modified, − deleted, R renamed. */
export function StatusIcon({ file }: { file: Pick<GitChangedFile, "status" | "untracked"> }) {
  const name = file.untracked ? "未跟踪的新文件" : STATUS_NAME[file.status];
  return (
    <span className={`gr-status ${file.status}${file.untracked ? " untracked" : ""}`} title={name} aria-label={name} role="img">
      {STATUS_GLYPH[file.status]}
    </span>
  );
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

/** Rows a chunk of the list, and their heights (.gr-file, .gr-dir). */
const LIST_CHUNK = 100;
const FILE_PX = 24;
const DIR_PX = 26;

const fileTitle = (f: GitChangedFile) => (f.oldPath ? `${f.oldPath} → ${f.path}` : f.path);

export function FileList({ files, layout, selected, active = true, perFile, closed, onToggle, onSelect, onHover, onMenu, group = "" }: FileListProps) {
  const tree = useMemo(() => (layout === "tree" ? buildTree(files) : null), [files, layout]);
  const rows = useMemo(() => (tree ? treeRows(tree, closed) : []), [tree, closed]);
  const flat = useMemo(() => (layout === "flat" ? listOrder(files) : []), [files, layout]);
  const currentFile = useRef<HTMLButtonElement>(null);
  // `keep` below mounts even a distant selected chunk; after it (or its folded ancestors) is drawn, reveal the row.
  // Nearest/instant keeps nearby selections still and follows repeated keys without a queued smooth animation.
  useLayoutEffect(() => {
    if (active) currentFile.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }, [selected, layout, rows, flat, active]);

  const fileRow = (f: GitChangedFile, name: string, depth: number | null) => (
    <button
      key={f.path}
      ref={f.path === selected ? currentFile : undefined}
      type="button"
      className={depth === null ? "gr-file flat" : "gr-file"}
      style={depth === null ? undefined : { paddingLeft: 6 + depth * 14 + 14 }}
      aria-current={f.path === selected}
      onClick={() => onSelect(f.path)}
      onPointerEnter={onHover && (() => onHover(f))}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        onSelect(f.path);
        onMenu(f, e.clientX, e.clientY);
      }}
      title={fileTitle(f)}
      data-testid="review-file"
    >
      <StatusIcon file={f} />
      <FileTypeIcon path={f.path} />
      {/* 平铺: the whole path, its folders dimmed and shortened first; the tree: the name. */}
      {depth === null ? <MiddleName text={name} split={splitPath} className="gr-name gr-path-name" /> : <MiddleName text={name} />}
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

  // Drawn near the view only (LazyChunks, 2026-10-20): a Unity import can change thousands of files; the selected one
  // is always there.
  if (layout === "flat")
    return (
      <LazyChunks
        items={flat}
        size={LIST_CHUNK}
        file={`${group}flat`}
        chunkClass="gr-file-chunk"
        guess={() => FILE_PX}
        keep={selected ? [flat.findIndex((f) => f.path === selected)].filter((i) => i >= 0) : []}
        render={(f) => fileRow(f, f.path, null)}
      />
    );
  return (
    <LazyChunks
      items={rows}
      size={LIST_CHUNK}
      file={`${group}tree`}
      chunkClass="gr-file-chunk"
      guess={(r) => (r.kind === "file" ? FILE_PX : DIR_PX)}
      keep={selected ? [rows.findIndex((r) => r.kind === "file" && r.file.path === selected)].filter((i) => i >= 0) : []}
      render={(r) =>
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
        )
      }
    />
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
      aria-valuemax={clampWidth(LIST_WIDTH.max, window.innerWidth)}
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
      onPointerMove={(e) => drag.current && onChange(clampWidth(drag.current.width + e.clientX - drag.current.x, window.innerWidth))}
      onPointerUp={() => (drag.current = null)}
      onLostPointerCapture={() => (drag.current = null)}
      onDoubleClick={() => onChange(LIST_WIDTH.initial)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        e.stopPropagation();
        onChange(clampWidth(width + (e.key === "ArrowLeft" ? -16 : 16), window.innerWidth));
      }}
    />
  );
}

export interface FileMenuAt {
  file: GitChangedFile;
  x: number;
  y: number;
}

/**
 * Right-click menu of a file row: a web page in the browser (2026-10-27), VS Code (when the machine has it) and
 * Explorer; a deleted file has none.
 */
export function FileMenu({ at, vscode, onOpen, onClose }: { at: FileMenuAt; vscode: boolean; onOpen(app: "vscode" | "explorer" | "browser"): void; onClose(): void }) {
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
  const item = (app: "vscode" | "explorer" | "browser", label: string) => (
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
    <div className="ctx-menu" role="menu" aria-label="文件" style={{ left: Math.min(at.x, window.innerWidth - 200), top: Math.min(at.y, window.innerHeight - 120) }}>
      {isWebPage(at.file.path) && item("browser", "浏览器打开")}
      {vscode && item("vscode", "VS Code 打开")}
      {item("explorer", "在资源管理器中显示")}
    </div>
  );
}
