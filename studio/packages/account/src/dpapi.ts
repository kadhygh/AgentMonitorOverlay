import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// The login key is kept encrypted for the current Windows user (DPAPI, CurrentUser scope), so any AMO tool running as
// that user can read it and nobody else can (2026-10-28). Not Electron's safeStorage: its key lives in one program's
// userData, so the other tools could not decrypt what the platform saved. No native module either: Windows PowerShell
// (always there) calls System.Security.Cryptography.ProtectedData. Text goes in as base64 in the child's environment
// and comes back as base64 on stdout, never on the command line or in the script, so it shows in no process list and no
// code page can mangle it. The script goes in on stdin as one line (10-28: no encoded command, no execution-policy
// bypass — an antivirus took that PowerShell elsewhere in AMO for a trojan; stdin runs line by line, and the try/catch
// makes a failure exit non-zero).

export interface Protector {
  /** Plain text → base64 of the encrypted bytes. */
  protect(text: string): Promise<string>;
  /** Base64 from `protect` → the plain text; rejects when this user cannot decrypt it. */
  unprotect(data: string): Promise<string>;
}

/** The child's environment variable with the input (base64; a login key, far below a variable's 32 767 characters). */
const INPUT_ENV = "AMO_DPAPI_INPUT";

const script = (op: "Protect" | "Unprotect") =>
  [
    "try { $ErrorActionPreference = 'Stop'",
    // Windows PowerShell 5 does not load the assembly by itself.
    "Add-Type -AssemblyName System.Security",
    `$in = [Convert]::FromBase64String(([string]$env:${INPUT_ENV}).Trim())`,
    `$out = [System.Security.Cryptography.ProtectedData]::${op}($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($out)) } catch { [Console]::Error.WriteLine($_); exit 1 }",
  ].join("; ") + "\n";

function powershell(): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const full = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(full) ? full : "powershell.exe";
}

function run(op: "Protect" | "Unprotect", inputBase64: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, [INPUT_ENV]: inputBase64 } });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(`DPAPI ${op} failed (${code}): ${err.trim().split(/\r?\n/)[0] ?? ""}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(script(op));
  });
}

/** DPAPI for the current Windows user. */
export const dpapi: Protector = {
  protect: async (text) => run("Protect", Buffer.from(text, "utf8").toString("base64")),
  unprotect: async (data) => Buffer.from(await run("Unprotect", data), "base64").toString("utf8"),
};
