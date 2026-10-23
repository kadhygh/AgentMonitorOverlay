import { MAX_VIEW_HIGHLIGHTS, type GitViewHighlight, type GitViewSource } from "@amo-studio/protocol";
import { HostError } from "../../../core/shared.js";
import { GitError, mergeBase, readCommit, readStatus, resolveCommit } from "../../gitreview/git.js";
import { common, optionalText, type ViewKindModule } from "./kind.js";
import { highlight } from "./file.js";

// Changes in git: the uncommitted ones, the working tree against a base, a commit (against its parent or a base), or
// a range (A..B; A...B from where B forked off A) — refs resolved to full ids when the pack is made, so it keeps
// showing the same thing. `files` are the ones the agent points at: listed first, above the rest (2026-10-23);
// `highlights` mark lines of them (new version), as a file item's 重点. The window shows it as Git Review does.

export const gitKind: ViewKindModule<"git"> = {
  kind: "git",

  async check(input, ctx) {
    const dir = ctx.workspace.path;
    const status = await readStatus(dir);
    if (!status.repo) throw new HostError("bad_request", `${ctx.workspace.name} 不是 git 仓库${status.reason ? `（${status.reason}）` : ""}`);
    const ref = (name: "base" | "commit" | "range") => optionalText(input[name], name, 300);
    const resolveRef = (r: string) =>
      resolveCommit(dir, r).catch((err: unknown) => {
        throw new HostError("bad_request", err instanceof GitError ? `找不到 ${r}：${err.message}` : String(err));
      });
    const range = ref("range");
    const commit = ref("commit");
    const base = ref("base");
    const kind = input.source ?? (range ? "range" : commit ? "commit" : base ? "base" : "working");
    let source: GitViewSource;
    if (kind === "working") {
      if (range || commit || base) throw new HostError("bad_request", "source working takes no base, commit or range");
      source = { kind: "working" };
    } else if (kind === "base") {
      if (!base || range || commit) throw new HostError("bad_request", "source base takes base only");
      source = { kind: "base", base: await resolveRef(base), label: base };
    } else if (kind === "commit") {
      if (!commit || range) throw new HostError("bad_request", "source commit takes commit (and optionally base)");
      source = { kind: "commit", commit: await resolveRef(commit), ...(base ? { base: await resolveRef(base), label: base } : {}) };
    } else if (kind === "range") {
      const m = range ? /^(.+?)(\.\.\.?)(.+)$/.exec(range) : null;
      if (!m || commit || base) throw new HostError("bad_request", "source range takes range: A..B or A...B");
      const head = await resolveRef(m[3]!);
      let from = await resolveRef(m[1]!);
      if (m[2] === "...") from = await mergeBase(dir, from, head);
      source = { kind: "commit", commit: head, base: from, label: m[2] === "..." ? `${m[1]} 的分叉点` : m[1]! };
    } else throw new HostError("bad_request", "source must be working, base, commit or range");
    const raw = input.files ?? [];
    if (!Array.isArray(raw) || raw.length > 200) throw new HostError("bad_request", "files must be a list of at most 200 paths");
    const files = [...new Set(raw.map((f, i) => ctx.relative(f, `files[${i}]`)))];
    const rawMarks = input.highlights ?? [];
    if (!Array.isArray(rawMarks)) throw new HostError("bad_request", "highlights must be a list");
    if (rawMarks.length > MAX_VIEW_HIGHLIGHTS) throw new HostError("bad_request", `at most ${MAX_VIEW_HIGHLIGHTS} highlights`);
    const highlights: GitViewHighlight[] = rawMarks.map((h, i) => {
      const name = `highlights[${i}]`;
      const path = ctx.relative((h as { path?: unknown } | null)?.path, `${name}.path`);
      return { path, ...highlight(h, name) };
    });
    // A file with 重点 is one the agent points at.
    for (const h of highlights) if (!files.includes(h.path)) files.push(h.path);
    if (source.kind === "commit") {
      const subject = await readCommit(dir, source.commit)
        .then((c) => c.commit.subject)
        .catch(() => "");
      if (subject) source = { ...source, subject };
    }
    return { kind: "git", source, files, highlights, ...common(input) };
  },

  merge(prev, next) {
    if (JSON.stringify(prev.source) !== JSON.stringify(next.source)) return null;
    // Either covering every file covers them all.
    const files = !prev.files.length || !next.files.length ? [] : [...new Set([...prev.files, ...next.files])];
    const key = (h: GitViewHighlight) => `${h.path}:${h.line}-${h.endLine ?? h.line}-${h.note}`;
    const seen = new Set((prev.highlights ?? []).map(key));
    const highlights = [...(prev.highlights ?? []), ...(next.highlights ?? []).filter((h) => !seen.has(key(h)))].slice(0, MAX_VIEW_HIGHLIGHTS);
    return { ...prev, ...(next.title ? { title: next.title } : {}), ...(next.note ? { note: next.note } : {}), files, highlights };
  },
};
