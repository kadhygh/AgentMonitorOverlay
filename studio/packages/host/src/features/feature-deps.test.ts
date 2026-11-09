import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Which features use which (plans/host-structure.md 8c, 2026-11-06). A feature names the others it uses in its class,
// `class DutyFeature extends Feature<"sessions" | "tasks">`, and only those are on its `this.f` (core/feature.ts); a
// module of its folder that needs the Host takes `FeatureHost<…>` the same way (guide/role.ts, remote's parts). Read
// from the sources here, with the value imports of another feature's files, as a graph by folder (features/<name>):
//   - an edge not in GRAPH below fails, and so does one in GRAPH that is gone (take it out);
//   - a cycle (features that reach each other) not inside KNOWN_CYCLES fails: those are known and to be untangled.
// Not counted: routes.ts and mcp.ts (the API, handed the whole Host), tests, `import type`, and imports of a file that
// reaches no feature itself (gitreview/git.ts, sessions/setups.ts: plain helpers that happen to live in a folder).

const SRC = resolve(fileURLToPath(import.meta.url), "..", "..");
const FEATURES = join(SRC, "features");
const HOW = "（依赖图：src/features/feature-deps.test.ts；为什么、怎么拆：plans/host-structure.md 的 8c）";

/** features/<folder> → the folders it uses. Sorted; GRAPH lists every folder that uses another. */
const GRAPH: Record<string, string[]> = {
  canvasreview: ["canvas", "sessions", "tasks"],
  cli: ["gitreview"],
  collab: ["sessions"],
  config: ["claudeaccounts", "scratchpad"],
  datamgmt: ["attachments", "projects"],
  duty: ["sessions", "tasks"],
  gitreview: ["projects", "remote", "sessions"],
  guide: ["config"],
  marks: ["openin"],
  planning: ["canvas", "tasks"],
  projects: ["tasks"],
  relays: ["collab", "sessions", "tasks"],
  remote: ["attachments", "channels", "chatfiles", "gitreview", "openin", "prompttemplates", "sessions", "tasks", "viewpacks"],
  review: ["sessions"],
  scratchpad: ["attachments"],
  sessions: ["attachments", "collab", "config", "mcp", "remote", "review", "tasks"],
  taskplans: ["canvas", "collab", "sessions", "tasks"],
  tasks: ["canvas", "config", "mcp", "remote", "sessions"],
  teamrelay: ["config", "sessions"],
  topics: ["tasks"],
  viewpacks: ["remote"],
};

/**
 * Known cycles, to be untangled (已知、待拆): each group is features that reach each other. The pairs in it, 2026-11-06:
 * tasks ⇄ sessions (a task starts sessions; a session starts tasks' sessions and reads their setups), sessions ⇄ collab
 * (mail goes into the inbox; reports go out as mail), sessions ⇄ review (sent annotations; quoted ones in a message),
 * sessions ⇄ remote, tasks ⇄ remote (copies' sessions and renames go to A; A starts sessions of granted tasks),
 * gitreview ⇄ remote and viewpacks ⇄ remote (opened on the paired device; A reads them for B); and through them
 * projects (archiving a project archives its tasks; opening a Review of a folder adds it as a project).
 */
const KNOWN_CYCLES: string[][] = [["collab", "gitreview", "projects", "remote", "review", "sessions", "tasks", "viewpacks"]];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".test-support.ts") ? [p] : [];
  });
}

const rel = (file: string) => relative(FEATURES, file).replaceAll("\\", "/");
const folderOf = (file: string): string | null => {
  const parts = rel(file).split("/");
  return parts.length > 1 && !parts[0]!.startsWith("..") ? parts[0]! : null;
};
/** The API files: they are handed the whole Host (8b types them), so they are not a feature's dependencies. */
const isApi = (file: string) => /\/(routes|mcp)\.ts$/.test(rel(file)) || !folderOf(file);

const files = sources(FEATURES);
const text = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

/** HostService field → the folder of its feature (service.ts `readonly x: XFeature = new XFeature(this)`). */
function featureFolders(): Map<string, string> {
  const classFolder = new Map<string, string>();
  for (const f of files) for (const m of text.get(f)!.matchAll(/export class (\w+) extends Feature\b/g)) classFolder.set(m[1]!, folderOf(f)!);
  const out = new Map<string, string>();
  for (const m of readFileSync(join(SRC, "service.ts"), "utf8").matchAll(/readonly (\w+): (\w+) = new \w+\(this\)/g)) {
    const folder = classFolder.get(m[2]!);
    if (folder) out.set(m[1]!, folder);
  }
  return out;
}

/** The feature names in each `Feature<…>` / `FeatureHost<…>` of a file: string literals, or a type of its folder naming them. */
function declared(file: string): string[] {
  const own = text.get(file)!;
  const aliases = new Map<string, string>();
  for (const f of files.filter((x) => folderOf(x) === folderOf(file))) {
    for (const m of text.get(f)!.matchAll(/type (\w+) = ((?:\s*\|?\s*"\w+")+);/g)) aliases.set(m[1]!, m[2]!);
  }
  const names: string[] = [];
  for (const m of own.matchAll(/\b(?:Feature|FeatureHost)<([^<>]*)>/g)) {
    for (const token of m[1]!.split("|").map((t) => t.trim())) {
      if (token === "never") continue;
      const literal = /^"(\w+)"$/.exec(token);
      if (literal) names.push(literal[1]!);
      else if (aliases.has(token)) names.push(...[...aliases.get(token)!.matchAll(/"(\w+)"/g)].map((x) => x[1]!));
      else throw new Error(`${rel(file)}：读不懂 Feature<${m[1]}> 里的 ${token}；写成 "名字" | "名字"，或者同一个文件夹里的 type X = "名字" | …`);
    }
  }
  return names;
}

/** Relative value imports (and re-exports) of a file, resolved to files. `import type` and all-`type` lists do not count. */
function valueImports(file: string): string[] {
  const out: string[] = [];
  for (const m of text.get(file)!.matchAll(/^(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+"(\.[^"]+)";/gm)) {
    if (m[1]) continue;
    const names = /\{([\s\S]*)\}/.exec(m[2]!)?.[1];
    if (names && m[2]!.trim().startsWith("{") && names.split(",").every((n) => !n.trim() || /^type\s/.test(n.trim()))) continue;
    const target = resolve(dirname(file), m[3]!.replace(/\.js$/, ".ts"));
    if (existsSync(target)) out.push(target);
  }
  return out;
}

/** A file that reaches no feature: no Feature / FeatureHost, and what it imports of features/ reaches none either. */
const leafMemo = new Map<string, boolean>();
function isLeaf(file: string): boolean {
  if (leafMemo.has(file)) return leafMemo.get(file)!;
  leafMemo.set(file, true); // an import cycle among plain files stays plain
  const own = text.get(file) ?? "";
  const leaf = !/\bextends Feature\b|\bFeatureHost\b/.test(own) && valueImports(file).filter((t) => folderOf(t)).every(isLeaf);
  leafMemo.set(file, leaf);
  return leaf;
}

/** folder → used folder → where it is said. */
function actualGraph(): Map<string, Map<string, string[]>> {
  const folders = featureFolders();
  const graph = new Map<string, Map<string, string[]>>();
  const add = (from: string, to: string, where: string) => {
    if (from === to) return;
    const edges = graph.get(from) ?? new Map<string, string[]>();
    edges.set(to, [...(edges.get(to) ?? []), where]);
    graph.set(from, edges);
  };
  for (const file of files.filter((f) => !isApi(f))) {
    const from = folderOf(file)!;
    for (const name of declared(file)) {
      const to = folders.get(name);
      if (!to) throw new Error(`${rel(file)} 声明了 "${name}"，但 HostService（src/service.ts）没有叫这个名字的 feature`);
      add(from, to, `${rel(file)} 的 Feature<…"${name}"…>`);
    }
    for (const target of valueImports(file)) {
      const to = folderOf(target);
      if (to && !isLeaf(target)) add(from, to, `${rel(file)} import 了 ${rel(target)}`);
    }
  }
  return graph;
}

/** Strongly connected groups of two or more (Tarjan). */
function cycles(graph: Map<string, Set<string>>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const group: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) out.push(group.sort());
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return out;
}

describe("feature dependencies", () => {
  const graph = actualGraph();
  const plain = new Map([...graph].map(([k, v]) => [k, new Set(v.keys())]));

  it("matches GRAPH: a new dependency is declared on purpose", () => {
    const added: string[] = [];
    for (const [from, edges] of graph) {
      for (const [to, where] of edges) {
        if (!GRAPH[from]?.includes(to)) added.push(`features/${from} 新用到了 features/${to}（${where.join("；")}）`);
      }
    }
    const gone = Object.entries(GRAPH).flatMap(([from, tos]) => tos.filter((to) => !plain.get(from)?.has(to)).map((to) => `${from} → ${to}`));
    expect(
      added,
      `有新的 feature 依赖。确认该有，就把它加进 GRAPH；如果它让两个 feature 互相用到（下一条测试会说），先想办法不要它：把公共的判断挪进 core/（像 core/role.ts、core/shared.ts 的 sessionMoving），或者在 src/service.ts 里用回调接起来（像 duty.registerCheck(issues.dutyCheck())）${HOW}`,
    ).toEqual([]);
    expect(gone, `这些依赖已经没了，把它们从 GRAPH 里删掉${HOW}`).toEqual([]);
  });

  it("has no cycle outside KNOWN_CYCLES", () => {
    const fresh = cycles(plain).filter((group) => !KNOWN_CYCLES.some((known) => group.every((f) => known.includes(f))));
    expect(
      fresh.map((g) => g.join(" ⇄ ")),
      `新的环：这些 feature 互相用到了。不要加进 KNOWN_CYCLES，改成单向：把两边都要的判断挪进 core/，或者让被调的一方在 src/service.ts 里接一个回调${HOW}`,
    ).toEqual([]);
  });

  it("lists in KNOWN_CYCLES only cycles still there", () => {
    // Each known group must still be one cycle (a group that grew is the test above's); one that came apart is stale.
    const now = cycles(plain);
    const stale = KNOWN_CYCLES.filter((known) => !now.some((g) => known.every((f) => g.includes(f)))).map((k) => k.join(" ⇄ "));
    expect(
      stale,
      `这些环已经拆开了（全部或一部分）：把 KNOWN_CYCLES 改成现在还在的环 ${JSON.stringify(now.filter((g) => KNOWN_CYCLES.some((k) => g.some((f) => k.includes(f)))))}，在 plans/host-structure.md 的 8c 记一笔${HOW}`,
    ).toEqual([]);
  });

  it("declares only features it uses", () => {
    const unused: string[] = [];
    for (const file of files.filter((f) => !isApi(f) && /\bextends Feature</.test(text.get(f)!))) {
      const folderText = files.filter((f) => folderOf(f) === folderOf(file) && !isApi(f)).map((f) => text.get(f)!).join("\n");
      for (const name of declared(file)) if (!new RegExp(`\\.${name}\\b`).test(folderText)) unused.push(`${rel(file)}："${name}"`);
    }
    expect(unused, `声明了却没用到的 feature：从 Feature<…> 里删掉${HOW}`).toEqual([]);
  });

  it("reaches the Host only through Feature<…> / FeatureHost<…> outside the API files", () => {
    const whole = files.filter((f) => !isApi(f) && /^import[^;]*\bHostService\b[^;]*from\s+"[./]*service\.js";/m.test(text.get(f)!)).map(rel);
    expect(whole, `这些文件拿了整个 HostService，它们用到哪些 feature 就看不出来了：改成 FeatureHost<"用到的"…>（core/feature.ts）${HOW}`).toEqual([]);
  });
});
