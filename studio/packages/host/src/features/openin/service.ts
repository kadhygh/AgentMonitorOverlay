import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize } from "node:path";
import { MAX_TEXT_FILE_BYTES, PREVIEW_IMAGE_TYPES, type Id, type OpenInApp, type OpenInApps, type OpenInRequest, type OpenInResult, type TextFile } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

const APPS: readonly OpenInApp[] = ["vscode", "explorer", "default"];
/** Bytes looked at to tell a binary file (a NUL among them). */
const SNIFF_BYTES = 8000;

/** How VS Code is started: its own CLI script when the install has one (what `code` runs), else Code.exe itself. */
interface VsCode {
  exe: string;
  cli: string | null;
}

/** A program start, recorded instead of run in test mode. */
export interface OpenInLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Opens files outside Studio (stage 12): in VS Code at a line, in Explorer with the file selected, or in its default
 * program; and reads one for a quick look. Programs start detached through execFile/spawn, never a shell.
 */
export class OpenInFeature extends Feature {
  /** Test runs (AMO_STUDIO_TEST=1) only record launches. */
  readonly launches: OpenInLaunch[] = [];
  private vscode: Promise<VsCode | null> | null = null;

  private get dryRun(): boolean {
    return process.env.AMO_STUDIO_TEST === "1";
  }

  async apps(): Promise<OpenInApps> {
    return { vscode: (await this.findVsCode()) !== null };
  }

  async open(input: Partial<OpenInRequest>): Promise<OpenInResult> {
    const app = input.app;
    if (!app || !APPS.includes(app)) throw new HostError("bad_request", `app must be one of ${APPS.join(", ")}`);
    const path = this.resolve(input.path, input.workspaceId);
    if (!existsSync(path)) throw new HostError("not_found", `${path} does not exist`);
    const isDir = (await stat(path)).isDirectory();
    let launch: OpenInLaunch;
    if (app === "vscode") {
      const code = await this.findVsCode();
      if (!code) throw new HostError("not_found", "VS Code was not found on this machine");
      const line = positive(input.line);
      const column = positive(input.column);
      const target = isDir ? [path] : line ? ["--goto", `${path}:${line}${column ? `:${column}` : ""}`] : [path];
      launch = code.cli ? { command: code.exe, args: [code.cli, ...target], env: { ELECTRON_RUN_AS_NODE: "1" } } : { command: code.exe, args: target };
    } else if (app === "explorer") {
      // Explorer reads `/select,"path"` itself; a Windows path cannot contain a quote, so the verbatim form is safe.
      launch = { command: "explorer.exe", args: isDir ? [`"${path}"`] : [`/select,"${path}"`] };
    } else {
      launch = { command: "explorer.exe", args: [`"${path}"`] };
    }
    this.launch(launch, app !== "vscode");
    return { app, path, dryRun: this.dryRun };
  }

  async readText(pathIn: unknown, workspaceId: unknown): Promise<TextFile> {
    const path = this.resolve(pathIn, workspaceId);
    const info = await stat(path).catch(() => null);
    if (!info) throw new HostError("not_found", `${path} does not exist`);
    if (info.isDirectory()) throw new HostError("bad_request", `${path} is a folder`);
    const base = { path, size: info.size, modifiedAt: info.mtime.toISOString() };
    if (info.size > MAX_TEXT_FILE_BYTES) return { ...base, tooLarge: true };
    const data = await readFile(path);
    const text = decode(data);
    return text === null ? { ...base, binary: true } : { ...base, text };
  }

  /** An image for a preview; other types are refused. */
  image(pathIn: unknown, workspaceId: unknown): { path: string; mime: string } {
    const path = this.resolve(pathIn, workspaceId);
    const mime = PREVIEW_IMAGE_TYPES[extname(path).toLowerCase()];
    if (!mime) throw new HostError("bad_request", "only images are served");
    if (!existsSync(path)) throw new HostError("not_found", `${path} does not exist`);
    return { path, mime };
  }

  /** An absolute path, or one relative to the project. */
  resolve(pathIn: unknown, workspaceId: unknown): string {
    if (typeof pathIn !== "string" || !pathIn.trim()) throw new HostError("bad_request", "path is required");
    let p = pathIn.trim();
    if (/^file:\/\//i.test(p)) p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, ""));
    if (isAbsolute(p)) return normalize(p);
    if (typeof workspaceId !== "string" || !workspaceId) throw new HostError("bad_request", "a relative path needs workspaceId");
    return normalize(join(this.requireWorkspace(workspaceId as Id).path, p));
  }

  private launch(l: OpenInLaunch, verbatim: boolean): void {
    if (this.dryRun) {
      this.launches.push(l);
      return;
    }
    const child = spawn(l.command, l.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      windowsVerbatimArguments: verbatim,
      env: { ...process.env, ...l.env },
    });
    child.on("error", () => undefined); // a missing program was checked before; nothing to tell the caller afterwards
    child.unref();
  }

  private findVsCode(): Promise<VsCode | null> {
    this.vscode ??= locateVsCode();
    return this.vscode;
  }
}

const positive = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);

/** UTF-8 (BOM dropped) or UTF-16 with a BOM; null for binary data. */
export function decode(data: Buffer): string | null {
  if (data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString("utf16le");
  if (data[0] === 0xfe && data[1] === 0xff) {
    const swapped = Buffer.from(data.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (data.subarray(0, SNIFF_BYTES).includes(0)) return null;
  const text = data.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Windows: App Paths (user, then machine), the usual install folders, then `code` on PATH. */
async function locateVsCode(): Promise<VsCode | null> {
  if (process.platform !== "win32") return null;
  const candidates: string[] = [];
  for (const hive of ["HKCU", "HKLM"]) {
    const value = await regDefault(`${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe`);
    if (value) candidates.push(value);
  }
  const env = process.env;
  if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"));
  for (const pf of [env.ProgramFiles, env["ProgramFiles(x86)"]]) if (pf) candidates.push(join(pf, "Microsoft VS Code", "Code.exe"));
  for (const dir of (env.PATH ?? "").split(";")) if (dir && existsSync(join(dir, "code.cmd"))) candidates.push(join(dir, "..", "Code.exe"));
  const exe = candidates.map((c) => normalize(c.replace(/^"|"$/g, ""))).find((c) => existsSync(c));
  return exe ? { exe, cli: cliScript(exe) } : null;
}

/** The CLI script `bin/code.cmd` runs (`<install>\<commit>\resources\app\out\cli.js` in current installs). */
export function cliScript(exe: string): string | null {
  const root = dirname(exe);
  try {
    const cmd = readFileSync(join(root, "bin", "code.cmd"), "utf8");
    const m = /%~dp0\.\.\\([^"\r\n]*cli\.js)/i.exec(cmd);
    if (m) {
      const cli = join(root, m[1]!);
      if (existsSync(cli)) return cli;
    }
  } catch {
    // no bin/code.cmd: fall through
  }
  const flat = join(root, "resources", "app", "out", "cli.js");
  return existsSync(flat) ? flat : null;
}

function regDefault(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("reg", ["query", key, "/ve"], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(stdout);
      resolve(m ? m[1]!.trim().replace(/%([^%]+)%/g, (_, n: string) => process.env[n] ?? `%${n}%`) : null);
    });
  });
}
