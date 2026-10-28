import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir, sha256Of } from "@amo-studio/testkit";
import { ENTRY_RECORD, entryOldFiles, entryVersion, refreshEntry, type EntryFile } from "./entry.js";

// The entry's files brought to the running version (entry.ts): only the manifest's paths whose content differs and the
// entry's own old files, never apps\ or anything else in the folder, never a file written in place (hard links share
// their data with the tools), old files moved aside under their own names, the version file last, and a failure put
// back and tried again later.

let root = "";
afterEach(() => {
  if (root) removeTempDir(root);
  root = "";
});
const ino = (p: string) => statSync(p, { bigint: true }).ino;
/** Names a refresh must not leave behind: its staging folders, or any renamed-beside-itself file. */
const leftovers = () => readdirSync(root, { recursive: true }).map(String).filter((n) => /(^|\\)apps\\\.entry-|\.amo-(old|new)/.test(n));

function put(base: string, files: Record<string, string>): void {
  for (const [p, content] of Object.entries(files)) {
    const file = join(base, ...p.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/**
 * A platform folder: the entry at 0.9.1 (its exe a hard link of the 便签's, as the shared runtime is), the 便签 in
 * apps, the platform's 0.9.2 in apps\platform, and a file of the person's own. LICENSE.txt is the same text in both.
 */
function folder(): { v2: string; files: EntryFile[] } {
  root = mkdtempSync(join(tmpdir(), "amo-entry-"));
  const v2 = join(root, "apps", "platform", "0.9.2");
  put(join(root, "apps", "notes", "1.0.0"), { "AMO Notes.exe": "runtime 1", "resources/app.txt": "notes" });
  put(root, { "resources/app/package.json": '{"version":"0.9.1"}', "resources/app/main.js": "0.9.1", "resources/app/old/only-old.js": "old", "LICENSE.txt": "MIT", "我的东西/笔记.txt": "mine" });
  linkSync(join(root, "apps", "notes", "1.0.0", "AMO Notes.exe"), join(root, "AMO Platform.exe"));
  const files: Record<string, string> = { "AMO Platform.exe": "runtime 2", "resources/app/package.json": '{"version":"0.9.2"}', "resources/app/main.js": "0.9.2", "resources/app/new/only-new.js": "new", "LICENSE.txt": "MIT" };
  put(v2, files);
  return { v2, files: Object.entries(files).map(([path, content]) => ({ path, size: Buffer.byteLength(content), sha256: sha256Of(content) })) };
}

/** Holds a file open without sharing (as a program using it would), until released. */
async function holdOpen(file: string): Promise<() => Promise<void>> {
  const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  await new Promise<void>((ready, fail) => {
    child.stdout.setEncoding("utf8").on("data", (d: string) => d.includes("held") && ready());
    child.on("error", fail);
    child.stdin.write(`$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null; $f.Close()\n`);
  });
  return () =>
    new Promise<void>((done) => {
      child.on("close", () => done());
      child.stdin.end("\n");
    });
}

const refresh = (v2: string, files: EntryFile[], oldFiles = entryOldFiles(root, () => null)) => refreshEntry({ root, version: "0.9.2", versionDir: v2, files, oldFiles });

describe("refreshEntry", () => {
  it("links in what differs, leaves what is the same, removes the entry's old files, and leaves apps\\ and the person's files alone", async () => {
    const { v2, files } = folder();
    const notesExe = join(root, "apps", "notes", "1.0.0", "AMO Notes.exe");
    const license = ino(join(root, "LICENSE.txt"));
    const apps = () => readdirSync(join(root, "apps"), { recursive: true }).map(String).sort();
    const appsBefore = apps();
    expect(entryVersion(root)).toBe("0.9.1");
    const r = await refresh(v2, files);
    // The exe, package.json, main.js and the new file; LICENSE.txt has the same content and is left as it is.
    expect(r).toEqual({ changed: 4, removed: 1, error: null });
    for (const f of ["AMO Platform.exe", "resources/app/package.json", "resources/app/main.js", "resources/app/new/only-new.js"]) expect(ino(join(root, ...f.split("/"))), f).toBe(ino(join(v2, ...f.split("/"))));
    expect(ino(join(root, "LICENSE.txt"))).toBe(license);
    expect(entryVersion(root)).toBe("0.9.2");
    expect(readFileSync(join(root, "AMO Platform.exe"), "utf8")).toBe("runtime 2");
    // The 便签's file, which the old exe was a link of, still has its own content: nothing was written in place.
    expect(readFileSync(notesExe, "utf8")).toBe("runtime 1");
    expect(existsSync(join(root, "resources", "app", "old"))).toBe(false);
    expect(readFileSync(join(root, "我的东西", "笔记.txt"), "utf8")).toBe("mine");
    // apps\ gained only the record; no staging folder or renamed names anywhere.
    expect(apps()).toEqual([...appsBefore, ENTRY_RECORD].sort());
    expect(leftovers()).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, "apps", ENTRY_RECORD), "utf8"))).toEqual({ version: "0.9.2", files: files.map((f) => f.path) });

    // Again: the record and the entry both say 0.9.2, nothing to look at.
    expect(await refresh(v2, files)).toEqual({ changed: 0, removed: 0, error: null });
  });

  it("never touches apps\\, whatever a manifest or an old list says", async () => {
    const { v2, files } = folder();
    put(v2, { "apps/notes/1.0.0/resources/app.txt": "overwritten?" });
    const extra = [{ path: "apps/notes/1.0.0/resources/app.txt", size: 12, sha256: sha256Of("overwritten?") }, { path: "Apps/x.txt", size: 1, sha256: sha256Of("x") }];
    const r = await refresh(v2, [...files, ...extra], ["apps/notes/1.0.0/AMO Notes.exe", "APPS/notes/1.0.0.json", "../outside.txt"]);
    expect(r.error).toBeNull();
    expect(readFileSync(join(root, "apps", "notes", "1.0.0", "resources", "app.txt"), "utf8")).toBe("notes");
    expect(existsSync(join(root, "apps", "notes", "1.0.0", "AMO Notes.exe"))).toBe(true);
  });

  it("the old files: the last record, else the entry version's manifest, else what is under resources\\app", () => {
    folder();
    expect(entryOldFiles(root, () => null).sort()).toEqual(["resources/app/main.js", "resources/app/old/only-old.js", "resources/app/package.json"]);
    expect(entryOldFiles(root, (v) => (v === "0.9.1" ? ["AMO Platform.exe", "d3dcompiler_47.dll"] : null))).toEqual(["AMO Platform.exe", "d3dcompiler_47.dll"]);
    writeFileSync(join(root, "apps", ENTRY_RECORD), JSON.stringify({ version: "0.9.1", files: ["x.dll"] }));
    expect(entryOldFiles(root, () => ["AMO Platform.exe"])).toEqual(["x.dll"]);
  });

  it("a file in use: everything swapped so far is put back (the entry still reads 0.9.1 and forwards), and the next try finishes", async () => {
    const { v2, files } = folder();
    const release = await holdOpen(join(root, "resources", "app", "main.js"));
    let r;
    try {
      r = await refresh(v2, files);
    } finally {
      await release();
    }
    expect(r.error).toBeTruthy();
    expect(r.changed).toBe(0);
    expect(readFileSync(join(root, "AMO Platform.exe"), "utf8")).toBe("runtime 1");
    expect(readFileSync(join(root, "resources", "app", "main.js"), "utf8")).toBe("0.9.1");
    expect(entryVersion(root)).toBe("0.9.1");
    expect(existsSync(join(root, "resources", "app", "old", "only-old.js"))).toBe(true);
    expect(existsSync(join(root, "resources", "app", "new"))).toBe(false);
    expect(existsSync(join(root, "apps", ENTRY_RECORD))).toBe(false);
    expect(leftovers()).toEqual([]);

    expect(await refresh(v2, files)).toMatchObject({ changed: 4, error: null });
    expect(entryVersion(root)).toBe("0.9.2");
  });

  it("a new file that cannot go in (a file where its folder must be): nothing changes", async () => {
    const { v2, files } = folder();
    writeFileSync(join(root, "resources", "app", "new"), "a file named like the new folder");
    const r = await refresh(v2, files);
    expect(r.error).toBeTruthy();
    expect(entryVersion(root)).toBe("0.9.1");
    expect(readFileSync(join(root, "AMO Platform.exe"), "utf8")).toBe("runtime 1");
    expect(readFileSync(join(root, "resources", "app", "new"), "utf8")).toBe("a file named like the new folder");
    expect(leftovers()).toEqual([]);
  });
});
