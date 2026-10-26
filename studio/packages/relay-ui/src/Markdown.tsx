import { Fragment, memo, type ReactNode } from "react";
import { shell } from "./env.js";

// Enough Markdown for requests and chat: headings, paragraphs (line breaks kept), lists, quotes, code fences, tables,
// rules; inline code, bold, italic, links. Built as React elements, never HTML, so a message cannot inject markup.

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "rule" };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      i++;
      out.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ kind: "heading", level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) {
      out.push({ kind: "rule" });
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(cells(lines[i++]!));
      out.push({ kind: "table", head, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+/;
    if (item.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && (item.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        const l = lines[i++]!;
        if (item.test(l)) items.push(l.replace(item, ""));
        else items[items.length - 1] += `\n${l.trim()}`;
      }
      out.push({ kind: "list", ordered, items });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>)/.test(lines[i]!) && !(body.length && item.test(lines[i]!))) body.push(lines[i++]!);
    out.push({ kind: "para", text: body.join("\n") });
  }
  return out;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()（）]+)/g;

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (!shell) return;
        e.preventDefault();
        shell.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const push = (s: string) => {
    s.split("\n").forEach((part, i) => {
      if (i) out.push(<br key={`br${n++}`} />);
      if (part) out.push(part);
    });
  };
  for (const m of text.matchAll(INLINE)) {
    push(text.slice(last, m.index));
    const [all] = m;
    const key = `i${n++}`;
    if (m[1]) out.push(<code key={key}>{all.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{inline(all.slice(2, -2))}</strong>);
    else if (m[3]) out.push(<em key={key}>{inline(all.slice(1, -1))}</em>);
    else if (m[4]) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(all)!;
      out.push(/^https?:/i.test(href!) ? <Link key={key} href={href!}>{label}</Link> : <Fragment key={key}>{label}</Fragment>);
    } else out.push(<Link key={key} href={all}>{all}</Link>);
    last = (m.index ?? 0) + all.length;
  }
  push(text.slice(last));
  return out;
}

export const Markdown = memo(function Markdown({ source }: { source: string }) {
  return (
    <div className="md">
      {parse(source).map((b, i) => {
        switch (b.kind) {
          case "heading": {
            const H = `h${Math.min(b.level + 2, 6)}` as "h3";
            return <H key={i}>{inline(b.text)}</H>;
          }
          case "para":
            return <p key={i}>{inline(b.text)}</p>;
          case "code":
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            );
          case "quote":
            return <blockquote key={i}>{inline(b.text)}</blockquote>;
          case "list": {
            const L = b.ordered ? "ol" : "ul";
            return (
              <L key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </L>
            );
          }
          case "table":
            return (
              <div key={i} className="md-table">
                <table>
                  <thead>
                    <tr>{b.head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "rule":
            return <hr key={i} />;
        }
      })}
    </div>
  );
});
