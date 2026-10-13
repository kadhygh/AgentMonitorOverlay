// Portable build: Electron's own runtime with Studio in resources/app, no installer, no asar.
//   npm run build && node scripts/package-portable.mjs [outDir]
// Layout (the dev layout is kept inside resources/app, so the app's relative paths still hold):
//   <out>/AMO Studio/AMO Studio.exe            Electron, renamed
//   <out>/AMO Studio/resources/app/package.json
//   <out>/AMO Studio/resources/app/packages/{app,host,protocol,ui}/   package.json + dist
//   <out>/AMO Studio/resources/app/node_modules/                      production dependencies, copied from studio/node_modules
// No network: Electron comes from node_modules/electron/dist and dependencies from the installed tree.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const studio = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = resolve(process.argv[2] ?? join(studio, "release"));
const appName = "AMO Studio";
const version = JSON.parse(readFileSync(join(studio, "package.json"), "utf8")).version;
const target = join(outRoot, appName);
const resources = join(target, "resources");
const app = join(resources, "app");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const started = Date.now();

rmSync(target, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

// 1. Electron runtime, renamed; its default app is dropped so resources/app is what runs.
cpSync(join(studio, "node_modules", "electron", "dist"), target, { recursive: true });
renameSync(join(target, "electron.exe"), join(target, `${appName}.exe`));
rmSync(join(resources, "default_app.asar"), { force: true });

// 2. Studio's own packages (only what runs: package.json and dist).
const own = { app: "packages/app", host: "packages/host", protocol: "packages/protocol", ui: "packages/ui" };
for (const [name, dir] of Object.entries(own)) {
  const from = join(studio, dir);
  if (!existsSync(join(from, "dist"))) throw new Error(`${dir}/dist is missing: run npm run build first`);
  cpSync(join(from, "dist"), join(app, dir, "dist"), { recursive: true });
  if (name !== "ui") cpSync(join(from, "package.json"), join(app, dir, "package.json"));
}
// The Host reads the Codex model catalogue from assets/ next to dist/.
cpSync(join(studio, own.host, "assets"), join(app, own.host, "assets"), { recursive: true });
// Workspace links become plain copies, so `@amo-studio/protocol` resolves from resources/app/node_modules.
for (const name of ["protocol", "host"]) {
  cpSync(join(studio, own[name], "dist"), join(app, "node_modules", "@amo-studio", name, "dist"), { recursive: true });
  cpSync(join(studio, own[name], "package.json"), join(app, "node_modules", "@amo-studio", name, "package.json"));
}
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "amo-studio", productName: appName, version, type: "module", main: "packages/app/dist/main.js" }, null, 2));

// 3. Production dependencies of host and app, with their dependency closure, copied from the installed tree. A package
//    is copied whole (including any nested node_modules npm put inside it).
const copied = new Set();
function copyDep(name, fromDir) {
  if (copied.has(name) || name.startsWith("@types/") || name.startsWith("@amo-studio/")) return;
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
for (const dir of [own.host, own.app]) {
  const pkg = readJson(join(studio, dir, "package.json"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) copyDep(dep, join(studio, dir));
}

function size(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of readdirSyncSafe(p)) total += size(join(p, name));
  return total;
}
function readdirSyncSafe(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}
import { readdirSync } from "node:fs";

const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;
console.log(
  JSON.stringify(
    {
      target,
      version,
      seconds: Math.round((Date.now() - started) / 1000),
      dependencies: [...copied].sort(),
      size: { total: mb(size(target)), electron: mb(size(target) - size(app)), app: mb(size(app)), nodeModules: mb(size(join(app, "node_modules"))) },
    },
    null,
    2,
  ),
);
