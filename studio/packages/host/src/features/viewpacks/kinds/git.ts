import type { GitViewSource } from "@amo-studio/protocol";
import { HostError } from "../../../core/shared.js";
import { GitError, mergeBase, readStatus, resolveCommit } from "../../gitreview/git.js";
import { common, optionalText, type ViewKindModule } from "./kind.js";

// Changes in git: the uncommitted ones, the working tree against a base, a commit (against its parent or a base), or
// a range (A..B; A...B from where B forked off A) — refs resolved to full ids when the pack is made, so it keeps
// showing the same thing. `files` keeps it to those files; the window shows them as Git Review does.

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
    return { kind: "git", source, files, ...common(input) };
  },

  merge(prev, next) {
    if (JSON.stringify(prev.source) !== JSON.stringify(next.source)) return null;
    // Either covering every file covers them all.
    const files = !prev.files.length || !next.files.length ? [] : [...new Set([...prev.files, ...next.files])];
    return { ...prev, ...(next.title ? { title: next.title } : {}), ...(next.note ? { note: next.note } : {}), files };
  },
};
