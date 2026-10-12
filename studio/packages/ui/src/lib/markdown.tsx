import type { ReactNode } from "react";

// Minimal, safe markdown for agent replies (stage 1): fenced code, headings, lists, quotes, paragraphs, and inline
// code / bold / italic / links. Everything is rendered as React text, never as HTML. Stage 2 (review) may replace this.

export type Block =
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "paragraph"; text: string };

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      blocks.push({ kind: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = !!item[2];
      const last = blocks.at(-1);
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item[3]!);
      else blocks.push({ kind: "list", ordered, items: [item[3]!] });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const last = blocks.at(-1);
      if (last?.kind === "quote") last.text += `\n${quote[1]}`;
      else blocks.push({ kind: "quote", text: quote[1]! });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;

export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (m[1]) out.push(<code key={key++} className="md-code">{token.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      // Shown as text with its target; opening external links is decided later (Electron shell.openExternal).
      out.push(
        <span key={key++} className="md-link" title={link[2]}>
          {link[1]}
        </span>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }) {
  return (
    <div className="md">
      {parseBlocks(source).map((b, i) => {
        switch (b.kind) {
          case "code":
            return (
              <pre key={i} className="md-pre" data-lang={b.lang || undefined}>
                {b.text}
              </pre>
            );
          case "heading":
            return (
              <div key={i} className={`md-h md-h${Math.min(b.level, 3)}`}>
                {renderInline(b.text)}
              </div>
            );
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag key={i} className="md-list">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </Tag>
            );
          }
          case "quote":
            return (
              <blockquote key={i} className="md-quote">
                {renderInline(b.text)}
              </blockquote>
            );
          default:
            return (
              <p key={i} className="md-p">
                {renderInline(b.text)}
              </p>
            );
        }
      })}
    </div>
  );
}
