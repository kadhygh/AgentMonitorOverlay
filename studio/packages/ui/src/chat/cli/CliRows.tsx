import { useContext, useEffect, useState } from "react";
import type { MessageImage, SessionItem } from "@amo-studio/protocol";
import { Markdown } from "../../lib/markdown.js";
import { rawFileUrl } from "../../lib/openin.js";
import { AttachLink, Lightbox } from "../../attach/MessageAttachments.js";
import { IconChevronDown, IconChevronUp, IconTerminal } from "../icons.js";
import { formatDuration, formatTokens } from "../turns.js";

// Rows for what the CLIs report besides replies and tool calls (stage 12, S12-E): a compaction, the output of a
// command that ran without the model, a notice (with how often it came), and images a tool showed.

type CompactionItem = Extract<SessionItem, { type: "compaction" }>;
type CommandItem = Extract<SessionItem, { type: "command" }>;
type NoticeItem = Extract<SessionItem, { type: "notice" }>;

/** "上下文已压缩（之前约 12k tok）", or the compaction still running, or why it failed. */
export function compactionLabel(item: CompactionItem): string {
  if (item.state === "running") return "正在压缩上下文…";
  if (item.state === "failed") return `上下文压缩失败${item.error ? `：${item.error}` : ""}`;
  const before = item.beforeTokens ? `（之前约 ${formatTokens(item.beforeTokens)} tok）` : "";
  return item.trigger === "auto" ? `上下文快满了，已自动压缩${before}` : `上下文已压缩${before}`;
}

export function CompactionRow({ item }: { item: CompactionItem }) {
  return (
    <div className={`msg-compaction ${item.state}`} data-testid="compaction" data-state={item.state} role={item.state === "failed" ? "alert" : undefined}>
      <span className="msg-compaction-rule" aria-hidden="true" />
      <span className={`msg-compaction-text${item.state === "running" ? " shimmer" : ""}`}>{compactionLabel(item)}</span>
      <span className="msg-compaction-rule" aria-hidden="true" />
    </div>
  );
}

/** Output with Markdown structure (headings, tables) renders; columns of plain text stay aligned. */
const looksMarkdown = (text: string) => /^#{1,4} |\n\|.*\|/m.test(text);

export function CommandRecord({ item }: { item: CommandItem }) {
  const lines = item.output.split("\n").length;
  const [open, setOpen] = useState(lines <= 16);
  return (
    <div className="msg-command" data-testid="command-output">
      <button type="button" className="msg-command-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <IconTerminal />
        <span className="msg-command-name">{item.name ? `/${item.name}` : "命令"} 的输出</span>
        <span className="msg-command-chev" aria-hidden="true">
          {open ? <IconChevronUp /> : <IconChevronDown />}
        </span>
      </button>
      {open &&
        (item.output.trim() ? (
          looksMarkdown(item.output) ? (
            <div className="msg-command-body md-body">
              <Markdown source={item.output} />
            </div>
          ) : (
            <pre className="msg-command-body">{item.output}</pre>
          )
        ) : (
          <div className="msg-command-body empty">（没有输出）</div>
        ))}
    </div>
  );
}

export function NoticeRow({ item }: { item: NoticeItem }) {
  return (
    <div className={item.level === "warning" ? "msg-notice warning" : "msg-notice"} data-testid="msg-notice">
      <span className={`state-dot ${item.level === "warning" ? "warn" : "info"}`} aria-hidden="true" />
      <span>{item.message}</span>
      {item.count && item.count > 1 ? (
        <span className="msg-notice-count" title={`出现了 ${item.count} 次`}>
          ×{item.count}
        </span>
      ) : null}
    </div>
  );
}

/** Thumbnails of the images a tool read, viewed or made (files on disk, through the Host); a click enlarges. */
export function ToolImages({ images }: { images: readonly MessageImage[] }) {
  const link = useContext(AttachLink);
  const [open, setOpen] = useState<string | null>(null);
  if (!images.length || !link) return null;
  return (
    <div className="pr-images" data-testid="tool-images">
      {images.map((img) => {
        const url = rawFileUrl(link, { path: img.path });
        return (
          <button key={img.path} type="button" className="msg-image" title={`${img.path}\n查看大图`} onClick={() => setOpen(url)}>
            <img src={url} alt={img.path.split(/[\\/]/).at(-1) ?? ""} loading="lazy" />
          </button>
        );
      })}
      {open && <Lightbox src={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** How long a running call has run, once it has run a while ("12秒"). */
export function Elapsed({ since, after = 3000 }: { since: string; after?: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = now - Date.parse(since);
  if (!(ms >= after)) return null;
  return <span className="pr-elapsed">{formatDuration(ms)}</span>;
}
