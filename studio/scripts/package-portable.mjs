// Portable builds (2026-10-24): three downloads, each Electron's own runtime with the program in resources/app, no
// installer, no asar.
//   AMO Studio    the whole tool: Studio, with AMO 便签 and Git Review / the viewer (AMO Reviewer's windows) in it
//   AMO Reviewer  Git Review and the viewer on their own, for any tool or model
//   AMO Notes     the 便签 on its own
//   npm run build && node scripts/package-portable.mjs [outDir] [--zip] [--only studio,reviewer,notes]   (npm run package:portable)
//   npm run package:portable -- --only notes      one tool only
//   npm run package:platform [-- --only studio]   the platform's folders (below), release/platform/<Name>/ — all the
//                                                 tools with `platform: true`, AMO 中转's client too (--only relay)
// Each tool has its own version (2026-10-28): its package's package.json (scripts/amo-tools.mjs says which package), in
// the zip's name, the exe's version info, resources/app/package.json and 使用说明.txt. Studio's download still carries
// the 便签 and the Reviewer, at whatever they are in this checkout.
// Layout (the dev layout is kept inside resources/app, so the programs' relative paths still hold):
//   <out>/<Name>/<Name>.exe                          Electron, renamed, with the program's icon and version info
//   <out>/<Name>/resources/app/package.json          main: launch.js
//   <out>/<Name>/resources/app/launch.js             runs the program, or the one --amo-app=<id> names (Studio starts
//                                                    its 便签 as `AMO Studio.exe --amo-app=notes`)
//   <out>/<Name>/resources/app/packages/<pkg>/       package.json + dist (+ assets): the packages reached by path (BY_PATH)
//   <out>/<Name>/resources/app/node_modules/         production dependencies, copied from studio/node_modules, without
//                                                    types, maps, docs and tests (shipped); @amo-studio/<pkg>: the
//                                                    workspace packages imported by name, or files forwarding to packages/
//   <out>/<Name>/使用说明.txt
// No network: Electron comes from node_modules/electron/dist and dependencies from the installed tree.
//
// Platform mode (2026-10-29, plans/amo-lan-platform.md 「共用 Electron」): `--platform` (npm run package:platform) builds
// the folders the platform installs, into release/platform/<Name>/ by default (platform-publish reads them from there).
// The exe is only renamed, never edited (no rcedit), so every tool's Electron files — the exe included — are byte for
// byte the same and the platform keeps one copy of them on a machine, hard-linked into each tool's folder (the cost:
// Explorer shows Electron's icon on these exes; windows and trays set their own). resources/app/package.json says which
// mode built the folder ("amoBuild": { mode, runtime }), and publish refuses a portable folder: its exes differ per
// tool, so nothing would be shared. The portable zips (the tools used without the platform) keep their own exe icons.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { TOOLS, studio, toolVersion } from "./amo-tools.mjs";
import { checkPackage } from "./check-package.mjs";

const args = process.argv.slice(2);
const platformMode = args.includes("--platform");
const outRoot = resolve(studio, args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--only") ?? (platformMode ? join("release", "platform") : "release"));
const zip = args.includes("--zip");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
if (platformMode && zip) throw new Error("--platform 打的是给平台发布的文件夹，不打 zip；portable zip 用 npm run package:portable");
/** The Electron the folders are built from (the manifest's `runtime`). */
const RUNTIME = JSON.parse(readFileSync(join(studio, "node_modules", "electron", "package.json"), "utf8")).version;
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** The program each package runs as (launch.js), when it is one. */
const MAINS = { studio: "packages/app/dist/main.js", reviewer: "packages/reviewer/dist/main.js", notes: "packages/notes/dist/main.js", platform: "packages/platform/dist/main.js", relay: "packages/relay-app/dist/main.js" };
/**
 * Workspace packages reached by their path in resources/app/packages: the programs (MAINS), the Host process Studio starts
 * (packages/host/dist/bin.js, which finds its assets and the app folder from there) and the UI folder.
 */
const BY_PATH = new Set(["app", "host", "reviewer", "notes", "platform", "relay-app", "ui"]);

// What a packed program carries (2026-11-03, plans/done/package-slim.md; the user settled the scope, only what is safe):
// no type declarations and no source maps; in third-party packages also none of their docs, tests, examples and tool
// configs. Licences (LICENSE, NOTICE, COPYING) stay, each package's as it ships. Kept on purpose: .ts sources, the empty
// modules of generated types, @anthropic-ai/sdk, the fonts.
const LICENCE = /^(licen[cs]e|notice|copying)/i;
const NOT_RUN_DIR = /^(test|tests|__tests__|example|examples|docs|\.github|benchmark|bench)$/i;
const NOT_RUN_FILE = [
  /^(readme|changelog|history|authors|contributing)\b/i,
  /\.(md|markdown)$/i,
  /^\.(eslintrc|nycrc|editorconfig|prettierrc|prettierignore|nvmrc|npmignore|travis\.yml|runkit_example\.js)/,
  /^tsconfig.*\.json$/,
  /^eslint\.config\.[cm]?js$/,
];
/** Whether a file or folder goes into the program folder; `packageRoot`: a third-party package the path is in. */
function shipped(path, packageRoot) {
  const name = basename(path);
  if (/\.d\.[cm]?ts$|\.map$|\.tsbuildinfo$/.test(name)) return false;
  if (!packageRoot || LICENCE.test(name)) return true;
  if (relative(packageRoot, path).split(sep).some((part) => NOT_RUN_DIR.test(part))) return false;
  return !NOT_RUN_FILE.some((re) => re.test(name));
}

/** node_modules/@amo-studio/<name> of a package that lives in packages/: its package.json and one file per export. */
function forwardPackage(name, from, app) {
  const pkg = readJson(join(from, "package.json"));
  const dir = join(app, "node_modules", "@amo-studio", name);
  const exportsOut = {};
  for (const [key, entry] of Object.entries(pkg.exports ?? { ".": { default: `./${pkg.main}` } })) {
    const target = typeof entry === "string" ? entry : entry.default ?? entry.import;
    const source = readFileSync(join(from, target), "utf8");
    // `export *` passes on every named export but not a default one.
    if (/^export default\b|^export \{[^}]*\bas default\b/m.test(source)) throw new Error(`@amo-studio/${name} 的 ${key} 有 export default，转发文件带不过去`);
    const file = key === "." ? "index.js" : `${key.slice(2).replaceAll("/", "-")}.js`;
    const to = relative(dir, join(app, "packages", name, target)).split(sep).join("/");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), `// Written by scripts/package-portable.mjs: @amo-studio/${name} lives in packages/${name}.\nexport * from "${to}";\n`);
    exportsOut[key] = `./${file}`;
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: "module", exports: exportsOut }, null, 2));
}

/** How each tool of TOOLS is built: its packages, the programs its exe can run, its icon and its 使用说明. */
const BUILDS = {
  studio: {
    packages: TOOLS.studio.packages,
    programs: ["studio", "notes", "reviewer"],
    // Claude Code (about 280 MB) is Anthropic's, not ours to hand out: Claude sessions use the person's own install.
    skipDeps: /^@anthropic-ai\/claude-agent-sdk-/,
    icon: () => join(studio, "packages", "app", "assets", "icon.ico"),
    readme: [
      "AMO Studio（完整版：工作台 + AMO 便签 + Git Review / 查看器）",
      "",
      "双击 AMO Studio.exe。第一次打开会让你选数据目录，默认是这个文件夹里的 data（整个文件夹拷走，数据就带走了）。",
      "AMO 便签会随 Studio 启动，在托盘里；全局快捷键默认 Ctrl+Shift+F12。便签的设置和页面在 %APPDATA%\\AMO Notes，",
      "和独立版 AMO Notes 共用同一份。Git Review 和查看器在 Studio 里打开（任务页的 Review、文件链接）。",
      "",
      "模型：Codex 需要本机装好 codex（npm i -g @openai/codex）。Claude 订阅、智谱 GLM 和「Claude 方案」的第三方渠道",
      "需要本机装好 Claude Code（PowerShell 里运行 irm https://claude.ai/install.ps1 | iex），Studio 不自带。",
      "Claude 订阅令牌和各渠道的 Key 在 设置 → 模型 里填。",
    ],
  },
  reviewer: {
    packages: TOOLS.reviewer.packages,
    programs: ["reviewer"],
    // Its Host runs no models; the SDK's JavaScript is still loaded.
    skipDeps: /^@anthropic-ai\/claude-agent-sdk-/,
    icon: () => join(studio, "packages", "reviewer", "assets", "icon.ico"),
    readme: [
      "AMO Reviewer（独立版：Git Review 和查看器，不需要 AMO Studio）",
      "",
      "用法（命令行，任何工具或模型都能调用；已经开着时由开着的那个打开）：",
      "  \"AMO Reviewer.exe\" <文件夹>                                     这个文件夹未提交的改动",
      "  \"AMO Reviewer.exe\" <文件夹> --base main                         对比 main",
      "  \"AMO Reviewer.exe\" <文件夹> --commit HEAD~1                     某个提交",
      "  \"AMO Reviewer.exe\" <文件夹> --mode file --file src\\a.cs --line 24 [--end-line 36]   查看器打开文件并定位",
      "",
      "写好批注后点「复制注释」或「复制并关闭」，贴回给需要的人或模型。最后一个窗口关掉，程序就退出。",
      "数据（批注记录）在 %APPDATA%\\AMO Reviewer。",
    ],
  },
  notes: {
    packages: TOOLS.notes.packages,
    programs: ["notes"],
    icon: (target) => {
      const ico = join(target, "notes.ico");
      writeFileSync(ico, icoFromPngs(["16", "20", "24", "32", "48", "64", null].map((s) => join(studio, "packages", "notes", "assets", s ? `icon-${s}.png` : "icon.png"))));
      return ico;
    },
    readme: [
      "AMO 便签（独立版）",
      "",
      "双击 AMO Notes.exe，它会待在托盘里：左键托盘图标显示 / 隐藏，右键是菜单（设置、退出）。",
      "全局快捷键默认 Ctrl+Shift+F12，Ctrl+Enter 复制当前页并隐藏，Alt+1…9 换页。",
      "设置和页面在 %APPDATA%\\AMO Notes（工作文件夹可以在设置里换）；和 AMO Studio 带的便签共用同一份。",
    ],
  },
  // AMO 平台 (2026-10-28, plans/amo-lan-platform.md): the tray app that installs and updates the others from the team server.
  platform: {
    packages: TOOLS.platform.packages,
    programs: ["platform"],
    icon: () => join(studio, "packages", "platform", "assets", "icon.ico"),
    readme: [
      "AMO 平台",
      "",
      "这个文件夹要放在能写入的地方（比如 D:\\TOOLS\\AMO Platform；不要放进 Program Files）。双击 AMO Platform.exe，用团队服务器的账号登录（和 AMO 中转同一个账号）。之后它待在托盘里：",
      "在「工具」里安装、打开、更新、回滚 AMO Studio、AMO Reviewer、AMO 便签；第一次打开 Studio 前先在「目录」里设好 Studio 数据目录。",
      "工具和平台自己的新版都装在这个文件夹的 apps 里（每个版本一个文件夹），AMO Platform.exe 会跟着换成新版，以后照旧双击它。要换位置，把整个文件夹移过去。设置和登录在 %APPDATA%\\AMO。",
      "想先用测试版：设置里把更新通道换成「测试」，或者带参数 --channel test 启动。",
    ],
  },
  // AMO 中转's desktop client (2026-10-26): a fixed shell; its content comes from the service. Platform mode (2026-10-28,
  // the user: it installs and updates through the platform like the others) is what the platform installs; the portable
  // zip is scripts/relay-release.mjs --shell's, for clients unpacked by hand (they still update themselves from it).
  relay: {
    packages: TOOLS.relay.packages,
    programs: ["relay"],
    icon: () => join(studio, "packages", "relay-app", "assets", "icon.ico"),
    readme: [
      "AMO 中转（桌面客户端）",
      "",
      "双击 AMO Relay.exe。第一次打开填服务器地址（同事发给你的下载页上有），然后注册一个名字和密码。",
      "关掉窗口会留在托盘里，新消息会弹提醒；托盘右键可以退出。",
      "客户端界面由服务器下发：有新版本时，登录页会提示「立即更新」，点一下就换好，不用重新下载。",
      "账号和密码（系统加密）、本机 AI 的接入信息都在 %APPDATA%\\AMO Relay。",
    ],
    platformReadme: [
      "AMO 中转（桌面客户端，AMO 平台装的）",
      "",
      "从 AMO 平台的「工具」里打开。第一次打开时服务器地址已经填好（平台登录的那个），在中转里登录或注册。",
      "关掉窗口会留在托盘里，新消息会弹提醒；托盘右键可以退出。",
      "客户端界面由服务器下发，自己更新；桌面程序（这个文件夹）由 AMO 平台更新，不要改这里的文件。",
      "账号和密码（系统加密）、本机 AI 的接入信息都在 %APPDATA%\\AMO Relay。",
    ],
    // relay-release --shell's build stamp: only the portable zip's 更新桌面程序 compares it with the service's zip.
    platformSkip: /[\\/]relay-app[\\/]dist[\\/]build\.json$/,
  },
};

/** An .ico of PNG images (Windows Vista and later read PNG entries). */
function icoFromPngs(files) {
  const pngs = files.map((f) => readFileSync(f));
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach((png, i) => {
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    const e = 6 + 16 * i;
    head.writeUInt8(w >= 256 ? 0 : w, e);
    head.writeUInt8(h >= 256 ? 0 : h, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs]);
}

function size(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of readdirSync(p)) total += size(join(p, name));
  return total;
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;
/** Takes away the folders `shipped` left empty (hono's dist/types…); true when `dir` itself is empty now. */
function removeEmptyDirs(dir) {
  let empty = true;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && removeEmptyDirs(join(dir, e.name))) rmSync(join(dir, e.name), { recursive: true });
    else empty = false;
  }
  return empty;
}
/** Files under `p` (what the platform's manifest lists one by one). */
const fileCount = (p) => readdirSync(p, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;

function build(id) {
  const spec = { ...TOOLS[id], ...BUILDS[id] };
  const version = toolVersion(id);
  const started = Date.now();
  const target = join(outRoot, spec.name);
  const resources = join(target, "resources");
  const app = join(resources, "app");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });

  // 1. Electron runtime, renamed; its default app is dropped so resources/app is what runs.
  cpSync(join(studio, "node_modules", "electron", "dist"), target, { recursive: true });
  renameSync(join(target, "electron.exe"), join(target, `${spec.name}.exe`));
  rmSync(join(resources, "default_app.asar"), { force: true });
  // Chromium UI strings: the programs' own UI is Chinese; keep Chinese and English (saves about 45 MB).
  const KEEP_LOCALES = new Set(["en-US.pak", "zh-CN.pak", "zh-TW.pak"]);
  for (const name of readdirSync(join(target, "locales"))) if (!KEEP_LOCALES.has(name)) rmSync(join(target, "locales", name));

  // 2. The program's own packages (only what runs: package.json, dist, assets), each in one place (2026-11-03, plans/done/
  //    package-slim.md: until then the ones imported by name were copied twice). In development npm links
  //    node_modules/@amo-studio/<name> to packages/<name>; here a package reached by path stays in packages/, one only
  //    imported by name goes to node_modules/@amo-studio/, and one that is both (host, reviewer) gets in node_modules only
  //    a package.json and files passing its exports on to packages/ — what the link did.
  const ownDeps = (name) => (name === "ui" ? [] : Object.keys(readJson(join(studio, "packages", name, "package.json")).dependencies ?? {}));
  for (const name of spec.packages) {
    const from = join(studio, "packages", name);
    if (!existsSync(join(from, "dist"))) throw new Error(`packages/${name}/dist is missing: run npm run build first`);
    const byPath = BY_PATH.has(name);
    const byName = spec.packages.some((other) => other !== name && ownDeps(other).includes(`@amo-studio/${name}`));
    const dest = byPath || !byName ? join(app, "packages", name) : join(app, "node_modules", "@amo-studio", name);
    cpSync(join(from, "dist"), join(dest, "dist"), { recursive: true, filter: (p) => shipped(p) && !/\.test\.js$/.test(p) && !(platformMode && spec.platformSkip?.test(p)) });
    if (name !== "ui") cpSync(join(from, "package.json"), join(dest, "package.json"));
    // Window, tray and exe icons (each tool's own since 2026-10-28, scripts/make-icons.mjs); the Codex model catalogue (host).
    if (existsSync(join(from, "assets"))) cpSync(join(from, "assets"), join(dest, "assets"), { recursive: true });
    if (byPath && byName) forwardPackage(name, from, app);
  }

  // 3. The launcher: this exe's own program, or the one --amo-app= names (only programs that are in this download).
  const mains = Object.fromEntries(spec.programs.map((p) => [p, MAINS[p]]));
  writeFileSync(
    join(app, "launch.js"),
    [
      "// Written by scripts/package-portable.mjs: which program this exe runs — its own, or the one --amo-app=<id> names.",
      `const MAINS = ${JSON.stringify(mains)};`,
      'const asked = process.argv.find((a) => a.startsWith("--amo-app="))?.slice("--amo-app=".length);',
      `await import(\`./\${MAINS[asked] ?? MAINS[${JSON.stringify(id)}]}\`);`,
      "",
    ].join("\n"),
  );
  const amoBuild = { mode: platformMode ? "platform" : "portable", runtime: RUNTIME };
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: spec.zip.toLowerCase(), productName: spec.name, version, type: "module", main: "launch.js", amoBuild }, null, 2));

  // 4. Portable: the exe's own icon and version info (Explorer, taskbar pin), with rcedit from devDependencies.
  //    Platform: the exe stays Electron's own, the same file in every tool. Windows and trays set their own icons; the
  //    platform makes no shortcuts (the user, 2026-10-29: tools it installed start from it), so no .ico goes along.
  if (!platformMode) {
    const icon = spec.icon(target);
    execFileSync(join(studio, "node_modules", "rcedit", "bin", "rcedit-x64.exe"), [
      join(target, `${spec.name}.exe`),
      "--set-icon", icon,
      "--set-version-string", "ProductName", spec.name,
      "--set-version-string", "FileDescription", spec.description,
      "--set-version-string", "CompanyName", "AMO",
      "--set-version-string", "OriginalFilename", `${spec.name}.exe`,
      "--set-file-version", version,
      "--set-product-version", version,
    ]);
    if (icon.startsWith(target)) rmSync(icon);
  }
  writeFileSync(join(target, "使用说明.txt"), [...((platformMode && spec.platformReadme) || spec.readme), "", `版本 ${version}`, ""].join("\r\n"), "utf8");

  // 5. Production dependencies of the packages, with their dependency closure, copied from the installed tree. A package
  //    is copied with any nested node_modules npm put inside it, less what does not run (shipped, 2026-11-03).
  const copied = new Set();
  function copyDep(name, fromDir) {
    if (copied.has(name) || name.startsWith("@types/") || name.startsWith("@amo-studio/") || spec.skipDeps?.test(name)) return;
    // Resolve like Node: the requiring package's own node_modules first, then the top level.
    const nested = join(fromDir, "node_modules", name);
    const top = join(studio, "node_modules", name);
    const src = existsSync(nested) ? nested : existsSync(top) ? top : null;
    if (!src) return; // an optional dependency for another platform
    if (src === nested) return; // copied along with its parent
    copied.add(name);
    cpSync(src, join(app, "node_modules", name), { recursive: true, dereference: true, filter: (p) => shipped(p, src) });
    const pkg = readJson(join(src, "package.json"));
    for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]) copyDep(dep, src);
  }
  for (const name of spec.packages.filter((n) => n !== "ui")) {
    const pkg = readJson(join(studio, "packages", name, "package.json"));
    for (const dep of Object.keys(pkg.dependencies ?? {})) copyDep(dep, join(studio, "packages", name));
  }
  removeEmptyDirs(app);

  const result = {
    program: spec.name,
    target,
    version,
    mode: amoBuild.mode,
    runtime: RUNTIME,
    seconds: Math.round((Date.now() - started) / 1000),
    dependencies: [...copied].sort(),
    size: { total: mb(size(target)), electron: mb(size(target) - size(app)), app: mb(size(app)) },
    files: { total: fileCount(target), app: fileCount(app) },
  };
  // 6. Every import written out in the folder finds its file (scripts/check-package.mjs), before anything is zipped.
  const { unexpected } = checkPackage(target);
  if (unexpected.length) throw new Error(`${spec.name}：这些 import 在打好的文件夹里找不到（scripts/check-package.mjs）：\n  ${unexpected.join("\n  ")}`);
  if (zip) {
    // Windows' own bsdtar writes zip archives (-a picks the format from the extension); nothing to install.
    const archive = join(outRoot, `${spec.zip}-${version}-portable.zip`);
    rmSync(archive, { force: true });
    const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    execFileSync(tar, ["-a", "-c", "-f", archive, "-C", outRoot, spec.name], { stdio: "inherit" });
    result.archive = archive;
    result.zipSize = mb(statSync(archive).size);
  }
  console.log(JSON.stringify(result, null, 2));
}

// Platform mode: every tool the platform installs, AMO 中转 included (2026-10-28). Portable: the relay client's zip comes
// from scripts/relay-release.mjs --shell (it lands in the service's downloads/), not with the others.
const ids = only ?? Object.keys(BUILDS).filter((p) => (platformMode ? TOOLS[p].platform : p !== "relay"));
for (const id of ids) if (!TOOLS[id] || !BUILDS[id]) throw new Error(`unknown program ${id}: ${Object.keys(BUILDS).join(", ")}`);
for (const id of ids) build(id);
