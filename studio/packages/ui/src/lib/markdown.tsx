import { createContext, Fragment, useContext, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { copyText } from "../host/client.js";
import { highlightLines, languageForFence, useGrammarLoads } from "./highlight.js";
import { CodeTokens } from "./CodeTokens.js";

// Safe markdown for agent replies: fenced code, headings, nested lists, tables, quotes, paragraphs, and inline
// code / bold / italic / links. Everything is rendered as React text, never as HTML. Every block carries its
// [start, end) range in the source so annotations can anchor to it (stage 2).

export interface ListItem {
  text: string;
  children: ListNode | null;
}
export interface ListNode {
  ordered: boolean;
  items: ListItem[];
}

export type Block = { start: number; end: number } & (
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; list: ListNode }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "quote"; text: string }
  | { kind: "paragraph"; text: string }
);

const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  return body.split("|").map((c) => c.trim());
}

/** Builds nested lists from indented item lines (2+ spaces of extra indent opens a child list). */
function buildList(lines: Array<{ indent: number; ordered: boolean; text: string }>): ListNode {
  const root: ListNode = { ordered: lines[0]!.ordered, items: [] };
  const stack: Array<{ node: ListNode; indent: number }> = [{ node: root, indent: lines[0]!.indent }];
  for (const l of lines) {
    while (stack.length > 1 && l.indent < stack.at(-1)!.indent) stack.pop();
    let top = stack.at(-1)!;
    if (l.indent >= top.indent + 2 && top.node.items.length) {
      const parent = top.node.items.at(-1)!;
      parent.children ??= { ordered: l.ordered, items: [] };
      stack.push({ node: parent.children, indent: l.indent });
      top = stack.at(-1)!;
    }
    top.node.items.push({ text: l.text, children: null });
  }
  return root;
}

export function parseBlocks(source: string): Block[] {
  const src = source.replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const offsets: number[] = [];
  let pos = 0;
  for (const line of lines) {
    offsets.push(pos);
    pos += line.length + 1;
  }
  const lineEnd = (i: number) => Math.min(src.length, offsets[i]! + lines[i]!.length);

  const blocks: Block[] = [];
  let para: number[] = [];
  const flush = () => {
    if (!para.length) return;
    blocks.push({ kind: "paragraph", text: para.map((i) => lines[i]).join("\n"), start: offsets[para[0]!]!, end: lineEnd(para.at(-1)!) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const first = i;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      const last = Math.min(i, lines.length - 1);
      blocks.push({ kind: "code", lang: fence[1] ?? "", text: body.join("\n"), start: offsets[first]!, end: lineEnd(last) });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]!, start: offsets[i]!, end: lineEnd(i) });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      flush();
      const first = i;
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(splitRow(lines[i++]!));
      i--;
      blocks.push({ kind: "table", header, rows: rows.map((r) => header.map((_, c) => r[c] ?? "")), start: offsets[first]!, end: lineEnd(i) });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      const first = i;
      const items: Array<{ indent: number; ordered: boolean; text: string }> = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]!);
        if (m) {
          items.push({ indent: m[1]!.length, ordered: !!m[3], text: m[4]! });
          i++;
        } else if (items.length && /^\s{2,}\S/.test(lines[i]!)) {
          // Lazy continuation line of the previous item.
          items.at(-1)!.text += `\n${lines[i]!.trim()}`;
          i++;
        } else break;
      }
      i--;
      blocks.push({ kind: "list", list: buildList(items), start: offsets[first]!, end: lineEnd(i) });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const last = blocks.at(-1);
      if (last?.kind === "quote" && last.end === offsets[i]! - 1) {
        last.text += `\n${quote[1]}`;
        last.end = lineEnd(i);
      } else blocks.push({ kind: "quote", text: quote[1]!, start: offsets[i]!, end: lineEnd(i) });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(i);
  }
  flush();
  return blocks;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/**
 * Turns inline code and links to local paths into file links where the page provides one (the conversation, stage
 * 12): `target` is the code or the link's destination, `fallback` what shows when it names no file.
 */
export const MarkdownFileLinks = createContext<ComponentType<{ kind: "code" | "link"; target: string; children: ReactNode; fallback: ReactNode }> | null>(null);

function InlineCode({ text }: { text: string }) {
  const FileLink = useContext(MarkdownFileLinks);
  const code = <code className="md-code">{text}</code>;
  return FileLink ? (
    <FileLink kind="code" target={text} fallback={code}>
      {code}
    </FileLink>
  ) : (
    code
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const safe = /^https?:\/\//i.test(href);
  const FileLink = useContext(MarkdownFileLinks);
  const link = (
    <a
      href={safe ? href : undefined}
      className="md-link"
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (safe) void window.amo?.openExternal?.(href);
      }}
    >
      {children}
    </a>
  );
  return FileLink && !safe ? (
    <FileLink kind="link" target={href} fallback={link}>
      {children}
    </FileLink>
  ) : (
    link
  );
}

export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (m[1]) out.push(<InlineCode key={key++} text={token.slice(1, -1)} />);
    else if (m[2]) out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    else if (m[4]) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      out.push(
        <ExternalLink key={key++} href={link[2]!}>
          {link[1]}
        </ExternalLink>,
      );
    } else {
      out.push(
        <ExternalLink key={key++} href={token}>
          {token}
        </ExternalLink>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function ListView({ list }: { list: ListNode }) {
  const Tag = list.ordered ? "ol" : "ul";
  return (
    <Tag className="md-list">
      {list.items.map((it, j) => (
        <li key={j}>
          <span className="md-li-text">{renderInline(it.text)}</span>
          {it.children && <ListView list={it.children} />}
        </li>
      ))}
    </Tag>
  );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  // Syntax colours (stage 12); plain until the grammar has loaded.
  const loads = useGrammarLoads();
  const lines = useMemo(() => highlightLines(text, languageForFence(lang)), [text, lang, loads]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="md-codeblock">
      <div className="md-code-head">
        <span>{lang || "代码"}</span>
        <button
          type="button"
          className="md-copy"
          onClick={() => {
            void copyText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="md-pre" data-lang={lines ? (languageForFence(lang) ?? undefined) : undefined}>
        {lines
          ? text.replace(/\r\n?/g, "\n").split("\n").map((line, i, all) => (
              <Fragment key={i}>
                <CodeTokens tokens={lines[i]} text={line} />
                {i < all.length - 1 ? "\n" : null}
              </Fragment>
            ))
          : text}
      </pre>
    </div>
  );
}

/** Ranges in the source to mark as annotated (blocks overlapping any of them get `md-annotated`). */
export type Highlight = { start: number; end: number };

export function Markdown({ source, highlights = [] }: { source: string; highlights?: readonly Highlight[] }) {
  return (
    <div className="md">
      {parseBlocks(source).map((b) => {
        const marked = highlights.some((h) => h.start < b.end && h.end > b.start);
        const range = { "data-src-start": b.start, "data-src-end": b.end, ...(marked ? { "data-annotated": "" } : {}) };
        const key = `${b.start}-${b.kind}`;
        switch (b.kind) {
          case "code":
            return (
              <div key={key} {...range} className="md-block">
                <CodeBlock lang={b.lang} text={b.text} />
              </div>
            );
          case "heading":
            return (
              <div key={key} {...range} className={`md-block md-h md-h${Math.min(b.level, 3)}`}>
                {renderInline(b.text)}
              </div>
            );
          case "list":
            return (
              <div key={key} {...range} className="md-block">
                <ListView list={b.list} />
              </div>
            );
          case "table":
            return (
              <div key={key} {...range} className="md-block md-table-wrap">
                <table className="md-table">
                  <thead>
                    <tr>
                      {b.header.map((h, c) => (
                        <th key={c}>{renderInline(h)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c}>{renderInline(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "quote":
            return (
              <blockquote key={key} {...range} className="md-block md-quote">
                {renderInline(b.text)}
              </blockquote>
            );
          default:
            return (
              <p key={key} {...range} className="md-block md-p">
                {renderInline(b.text)}
              </p>
            );
        }
      })}
    </div>
  );
}
