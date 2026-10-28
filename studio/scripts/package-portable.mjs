// Portable builds (2026-10-24): three downloads, each Electron's own runtime with the program in resources/app, no
// installer, no asar.
//   AMO Studio    the whole tool: Studio, with AMO 便签 and Git Review / the viewer (AMO Reviewer's windows) in it
//   AMO Reviewer  Git Review and the viewer on their own, for any tool or model
//   AMO Notes     the 便签 on its own
//   npm run build && node scripts/package-portable.mjs [outDir] [--zip] [--only studio,reviewer,notes]   (npm run package:portable)
//   npm run package:portable -- --only notes      one tool only
// Each tool has its own version (2026-10-28): its package's package.json (scripts/amo-tools.mjs says which package), in
// the zip's name, the exe's version info, resources/app/package.json and 使用说明.txt. Studio's download still carries
// the 便签 and the Reviewer, at whatever they are in this checkout.
// Layout (the dev layout is kept inside resources/app, so the programs' relative paths still hold):
//   <out>/<Name>/<Name>.exe                          Electron, renamed, with the program's icon and version info
//   <out>/<Name>/resources/app/package.json          main: launch.js
//   <out>/<Name>/resources/app/launch.js             runs the program, or the one --amo-app=<id> names (Studio starts
//                                                    its 便签 as `AMO Studio.exe --amo-app=notes`)
//   <out>/<Name>/resources/app/packages/<pkg>/       package.json + dist (+ assets)
//   <out>/<Name>/resources/app/node_modules/         production dependencies, copied from studio/node_modules
//   <out>/<Name>/使用说明.txt
// No network: Electron comes from node_modules/electron/dist and dependencies from the installed tree.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TOOLS, studio, toolVersion } from "./amo-tools.mjs";

const args = process.argv.slice(2);
const outRoot = resolve(studio, args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--only") ?? "release");
const zip = args.includes("--zip");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** The program each package runs as (launch.js), when it is one. */
const MAINS = { studio: "packages/app/dist/main.js", reviewer: "packages/reviewer/dist/main.js", notes: "packages/notes/dist/main.js", relay: "packages/relay-app/dist/main.js" };

/** How each tool of TOOLS is built: its packages, the programs its exe can run, its icon and its 使用说明. */
const BUILDS = {
  studio: {
    packages: ["app", "host", "protocol", "ui", "reviewer", "notes"],
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
    packages: ["reviewer", "host", "protocol", "ui"],
    programs: ["reviewer"],
    // Its Host runs no models; the SDK's JavaScript is still loaded.
    skipDeps: /^@anthropic-ai\/claude-agent-sdk-/,
    icon: () => join(studio, "packages", "app", "assets", "icon.ico"),
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
    packages: ["notes", "protocol", "ui"],
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
  // AMO 中转's desktop client (2026-10-26): a fixed shell; its content comes from the service (scripts/relay-release.mjs
  // builds this into the service's downloads/).
  relay: {
    packages: ["relay-app", "relay"],
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

  // 2. The program's own packages (only what runs: package.json, dist, assets).
  for (const name of spec.packages) {
    const dir = `packages/${name}`;
    const from = join(studio, dir);
    if (!existsSync(join(from, "dist"))) throw new Error(`${dir}/dist is missing: run npm run build first`);
    cpSync(join(from, "dist"), join(app, dir, "dist"), { recursive: true, filter: (p) => !/\.(tsbuildinfo|map)$|\.test\.js$/.test(p) });
    if (name !== "ui") cpSync(join(from, "package.json"), join(app, dir, "package.json"));
    // Window and tray icons (app, notes); the Codex model catalogue (host).
    if (existsSync(join(from, "assets"))) cpSync(join(from, "assets"), join(app, dir, "assets"), { recursive: true });
    // Workspace links become plain copies, so `@amo-studio/<name>` resolves from resources/app/node_modules.
    if (["protocol", "host", "reviewer", "relay"].includes(name)) {
      cpSync(join(from, "dist"), join(app, "node_modules", "@amo-studio", name, "dist"), { recursive: true, filter: (p) => !/\.(tsbuildinfo|map)$|\.test\.js$/.test(p) });
      cpSync(join(from, "package.json"), join(app, "node_modules", "@amo-studio", name, "package.json"));
    }
  }
  // The Reviewer's windows take Studio's mark when it has none of its own.
  if (spec.packages.includes("reviewer") && !existsSync(join(app, "packages", "reviewer", "assets", "icon.png"))) {
    mkdirSync(join(app, "packages", "reviewer", "assets"), { recursive: true });
    cpSync(join(studio, "packages", "app", "assets", "icon.png"), join(app, "packages", "reviewer", "assets", "icon.png"));
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
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: spec.zip.toLowerCase(), productName: spec.name, version, type: "module", main: "launch.js" }, null, 2));

  // 4. The exe's own icon and version info (Explorer, taskbar pin), with rcedit from devDependencies.
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
  writeFileSync(join(target, "使用说明.txt"), [...spec.readme, "", `版本 ${version}`, ""].join("\r\n"), "utf8");

  // 5. Production dependencies of the packages, with their dependency closure, copied from the installed tree. A package
  //    is copied whole (including any nested node_modules npm put inside it).
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
    cpSync(src, join(app, "node_modules", name), { recursive: true, dereference: true });
    const pkg = readJson(join(src, "package.json"));
    for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]) copyDep(dep, src);
  }
  for (const name of spec.packages.filter((n) => n !== "ui")) {
    const pkg = readJson(join(studio, "packages", name, "package.json"));
    for (const dep of Object.keys(pkg.dependencies ?? {})) copyDep(dep, join(studio, "packages", name));
  }

  const result = {
    program: spec.name,
    target,
    version,
    seconds: Math.round((Date.now() - started) / 1000),
    dependencies: [...copied].sort(),
    size: { total: mb(size(target)), electron: mb(size(target) - size(app)), app: mb(size(app)) },
  };
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

// The relay client ships from its service (scripts/relay-release.mjs), not with the other three.
const ids = only ?? Object.keys(BUILDS).filter((p) => p !== "relay");
for (const id of ids) if (!TOOLS[id] || !BUILDS[id]) throw new Error(`unknown program ${id}: ${Object.keys(BUILDS).join(", ")}`);
for (const id of ids) build(id);
