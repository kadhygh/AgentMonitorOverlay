import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// The login key is kept encrypted for the current Windows user (DPAPI, CurrentUser scope), so any AMO tool running as
// that user can read it and nobody else can (2026-10-28). Not Electron's safeStorage: its key lives in one program's
// userData, so the other tools could not decrypt what the platform saved. No native module either: Windows PowerShell
// (always there) calls System.Security.Cryptography.ProtectedData. Text goes in and out as base64 over stdin/stdout,
// never on the command line, so it shows in no process list and no code page can mangle it.

export interface Protector {
  /** Plain text → base64 of the encrypted bytes. */
  protect(text: string): Promise<string>;
  /** Base64 from `protect` → the plain text; rejects when this user cannot decrypt it. */
  unprotect(data: string): Promise<string>;
}

const script = (op: "Protect" | "Unprotect") =>
  [
    "$ErrorActionPreference = 'Stop'",
    // Windows PowerShell 5 does not load the assembly by itself.
    "Add-Type -AssemblyName System.Security",
    "$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
    `$out = [System.Security.Cryptography.ProtectedData]::${op}($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join("; ");

function powershell(): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const full = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(full) ? full : "powershell.exe";
}

function run(op: "Protect" | "Unprotect", inputBase64: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script(op), "utf16le").toString("base64");
    const child = spawn(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(`DPAPI ${op} failed (${code}): ${err.trim().split(/\r?\n/)[0] ?? ""}`));
    });
    child.stdin.end(inputBase64);
  });
}

/** DPAPI for the current Windows user. */
export const dpapi: Protector = {
  protect: async (text) => run("Protect", Buffer.from(text, "utf8").toString("base64")),
  unprotect: async (data) => Buffer.from(await run("Unprotect", data), "base64").toString("utf8"),
};
