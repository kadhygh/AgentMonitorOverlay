// Tests must not write a port of 47950–47999 by hand (2026-11-16, the user: 项目规范里加一些设置避免出现这种情况). That
// range is where the fake servers and a Host started with port 0 take a random free port (listenInStudioRange), so a
// fixed one there is taken by the very server the test talks to one run in 50 — and the server of a file is started
// once, so the retry fails too: 自动打包 of Studio 0.9.43 and 0.9.72 stopped on platform.test.ts's fixed 47999, twice
// put down as 「偶发」. A test that needs an address nothing listens on takes testkit's standInPort(real servers…); one
// that needs a server listens with listenInStudioRange. Each failure below says the file, the line and what to do.
// Nor may a test's own server listen on port 0 (2026-11-23, the user: 能拦住 listen(0) 的话就补上): the system picks
// from 1024–15000 on this machine, where fetch refuses a few ports outright (5060, 6000… — 「bad port」), so one run now
// and then fails: mirror.test.ts's fake mirror did. startRelayServer({ port: 0 }) is not this: the relay takes another
// port itself then (FETCH_BAD_PORTS in packages/relay/src/server.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const STUDIO = resolve(fileURLToPath(import.meta.url), "..", "..");
const SELF = "scripts/test-ports.test.mjs";

/** A fixed port here that is right as it is: file (from studio/) → why. Empty on purpose; a reason is needed to add one. */
const ALLOWED = {};

function walk(dir, keep) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p, keep) : keep(e.name) ? [p] : [];
  });
}

/** The line without its comment (`// …` after a space or at the start — not the `//` of a URL), null for a comment line. */
function code(line) {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return null;
  return line.replace(/(^|\s)\/\/.*$/, "");
}

export function fixedSparePorts(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    const c = code(line);
    for (const m of c?.matchAll(/(?<![\d.])479[5-9]\d(?!\d)/g) ?? []) out.push({ line: i + 1, port: m[0] });
    // The same port written as an offset from the range's ends (2026-11-25: ports.test.ts's 「STUDIO_SPARE_PORTS[0] + 20」
    // was 47970, both of its two ports were held by another worker's server, and 自动打包 of Studio 0.9.82 stopped on it).
    // Not the range's width (「hi - lo + 1」).
    for (const m of c?.matchAll(/(?<![-+]\s*)STUDIO_SPARE_PORTS\[[01]\]\s*[-+]\s*\d+/g) ?? []) out.push({ line: i + 1, port: m[0] });
  });
  return out;
}

/** `.listen(0…)`, `.listen()` or `.listen({ port: 0 …})` of a server a test starts itself. */
export function systemPickedPorts(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    const c = code(line);
    if (c && /\.listen\(\s*(?:0\s*[,)]|\)|\{\s*port:\s*0\s*[,}])/.test(c)) out.push({ line: i + 1 });
  });
  return out;
}

/** The tests' files: unit tests and their support files, e2e, the scripts' tests. */
const testFiles = () => [
  ...walk(join(STUDIO, "packages"), (n) => n.endsWith(".test.ts") || n.endsWith(".test-support.ts")),
  ...walk(join(STUDIO, "e2e"), (n) => n.endsWith(".ts")),
  ...walk(join(STUDIO, "scripts"), (n) => n.endsWith(".test.mjs")),
];

describe("测试里的端口", () => {
  it("不写死 47950–47999 里的端口（假服务器随机拿的那一段）", () => {
    const problems = [];
    for (const file of testFiles()) {
      const rel = relative(STUDIO, file).replaceAll("\\", "/");
      if (rel === SELF || ALLOWED[rel]) continue;
      for (const hit of fixedSparePorts(readFileSync(file, "utf8")))
        problems.push(`${rel}:${hit.line} 写死了端口 ${hit.port}：这一段是假服务器随机拿的，会撞上。要一个没人监听的假地址用 testkit 的 standInPort(真服务器的地址…)；要起服务器用 listenInStudioRange`);
    }
    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  });

  it("不让自己起的服务器 listen(0)（系统给的端口可能是 fetch 拒绝的 bad port）", () => {
    const problems = [];
    for (const file of testFiles()) {
      const rel = relative(STUDIO, file).replaceAll("\\", "/");
      if (rel === SELF) continue;
      for (const hit of systemPickedPorts(readFileSync(file, "utf8")))
        problems.push(`${rel}:${hit.line} 让系统挑端口（listen(0)）：这台机器给的是 1024–15000，里面有 fetch 直接拒绝的端口（bad port），偶尔就失败。改用 testkit 的 listenInStudioRange(server)`);
    }
    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  });

  it("认得出写死的端口，不把注释、别的号段和更长的数字算进去", () => {
    expect(fixedSparePorts('const url = "http://127.0.0.1:47999/x";')).toEqual([{ line: 1, port: "47999" }]);
    expect(fixedSparePorts("listen(47950); // was 47960")).toEqual([{ line: 1, port: "47950" }]);
    expect(fixedSparePorts("// 47999\n * 47998\nconst a = 47900, b = 47949, c = 1479990, d = 0.47955;")).toEqual([]);
    expect(fixedSparePorts("const range = [STUDIO_SPARE_PORTS[0] + 20, STUDIO_SPARE_PORTS[1]-1];")).toEqual([
      { line: 1, port: "STUDIO_SPARE_PORTS[0] + 20" },
      { line: 1, port: "STUDIO_SPARE_PORTS[1]-1" },
    ]);
    expect(fixedSparePorts("const count = STUDIO_SPARE_PORTS[1] - STUDIO_SPARE_PORTS[0] + 1;")).toEqual([]);
  });

  it("认得出 listen(0)，不把 startRelayServer({ port: 0 })、注释和别的端口算进去", () => {
    const bad = ['await new Promise((r) => server.listen(0, "127.0.0.1", r));', "server.listen(0);", "server.listen();", "app.listen({ port: 0, host })", "x.listen( 0 )"];
    for (const line of bad) expect(systemPickedPorts(line), line).toEqual([{ line: 1 }]);
    expect(systemPickedPorts('startRelayServer({ store, host: "127.0.0.1", port: 0 });\n// server.listen(0)\nserver.listen(port, host);\nserver.listen(10080);\nlisten({ port: 0 });')).toEqual([]);
  });
});
