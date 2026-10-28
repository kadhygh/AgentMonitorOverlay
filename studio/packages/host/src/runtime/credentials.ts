import { execFile, execFileSync } from "node:child_process";

// Access to API keys that old AMO stored in the Windows Credential Manager under
// `AgentMonitorOverlay/model-provider/<id>` (UTF-8 blob). Keys never leave memory except as child-process env vars.
// Studio only reads them; the one entry it writes is the Claude subscription token the person saves in 设置 → 模型凭据
// (HostService keeps that list). The secret reaches PowerShell in its environment, never on its command line or in its
// script; stdout is UTF-8 (it was the console code page, which garbled anything but ASCII on its way back, 2026-10-20).

export interface CredentialReader {
  /** The secret, or null when the entry does not exist. */
  read(credentialId: string): string | null;
}

/** A reader that can also save and remove entries. */
export interface CredentialStore extends CredentialReader {
  write(credentialId: string, secret: string): void;
  remove(credentialId: string): void;
}

export const CREDENTIAL_TARGET_PREFIX = "AgentMonitorOverlay/model-provider/";

const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"];

// The scripts go to PowerShell on stdin (`-Command -`), not as an encoded command (10-28: an antivirus took the encoded
// PowerShell elsewhere in Studio for a trojan). Stdin runs line by line and a here-string or a block over several lines
// breaks there, so each script is one line: the C# type on one line too, the whole in try/catch so that a failure exits
// non-zero. The script holds only ASCII (stdin is read in the console code page) and never a secret.
const CRED_STRUCT = [
  "[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]",
  "public struct CRED { public int Flags; public int Type; public string TargetName; public string Comment;",
  "public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;",
  "public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }",
];

/** A PowerShell single-quoted string. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** One line: UTF-8 out, the C# type compiled, then `run`; any error exits 1 with the message on stderr. */
function oneLine(csharp: string[], run: string): string {
  const type = ["using System; using System.Runtime.InteropServices; using System.Text;", ...csharp].join(" ");
  return `try { $ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Add-Type -TypeDefinition ${psQuote(type)}; ${run} } catch { [Console]::Error.WriteLine($_); exit 1 }\n`;
}

function readScript(target: string): string {
  return oneLine(
    [
      "public static class AmoCred {",
      ...CRED_STRUCT,
      '[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredReadW(string t, int type, int f, out IntPtr c);',
      '[DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);',
      'public static string Read(string t) { IntPtr p; if (!CredReadW(t, 1, 0, out p)) return "";',
      "var c = (CRED)Marshal.PtrToStructure(p, typeof(CRED));",
      "var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length);",
      "CredFree(p); return Encoding.UTF8.GetString(b); }",
      "}",
    ],
    `[Console]::Out.Write([AmoCred]::Read(${psQuote(target)}))`,
  );
}

// Every entry under the prefix at once (one C# compile instead of one per key): "<id>\t<base64 of the blob>" lines.
function enumerateScript(prefix: string): string {
  return oneLine(
    [
      "public static class AmoCredE {",
      ...CRED_STRUCT,
      '[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredEnumerateW(string filter, int flags, out int count, out IntPtr creds);',
      '[DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);',
      "public static string List(string prefix) { int n; IntPtr list; var sb = new StringBuilder();",
      'if (!CredEnumerateW(prefix + "*", 0, out n, out list)) return "";',
      "for (int i = 0; i < n; i++) {",
      "var c = (CRED)Marshal.PtrToStructure(Marshal.ReadIntPtr(list, i * IntPtr.Size), typeof(CRED));",
      "if (c.Type != 1 || c.TargetName == null || !c.TargetName.StartsWith(prefix)) continue;",
      "var b = new byte[c.CredentialBlobSize]; if (b.Length > 0) Marshal.Copy(c.CredentialBlob, b, 0, b.Length);",
      'sb.Append(c.TargetName.Substring(prefix.Length)).Append("\\t").Append(Convert.ToBase64String(b)).Append("\\n"); }',
      "CredFree(list); return sb.ToString(); }",
      "}",
    ],
    `[Console]::Out.Write([AmoCredE]::List(${psQuote(prefix)}))`,
  );
}

/** The child's environment variable that carries a secret being saved: never in the script, never on the command line. */
const SECRET_ENV = "AMO_STUDIO_CREDENTIAL_SECRET";

// Saves the secret from SECRET_ENV as a generic credential (UTF-8 blob, like old AMO's entries), or deletes the entry.
function writeScript(target: string, remove: boolean): string {
  return oneLine(
    [
      "public static class AmoCredW {",
      ...CRED_STRUCT,
      '[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWriteW(ref CRED c, int f);',
      '[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDeleteW(string t, int type, int f);',
      "public static void Write(string t, string secret) {",
      "var b = Encoding.UTF8.GetBytes(secret);",
      'var c = new CRED(); c.Type = 1; c.TargetName = t; c.UserName = "amo-studio"; c.Persist = 2;',
      "c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocHGlobal(b.Length);",
      'try { Marshal.Copy(b, 0, c.CredentialBlob, b.Length); if (!CredWriteW(ref c, 0)) throw new Exception("CredWrite failed: " + Marshal.GetLastWin32Error()); }',
      "finally { Marshal.FreeHGlobal(c.CredentialBlob); } }",
      'public static void Delete(string t) { if (!CredDeleteW(t, 1, 0) && Marshal.GetLastWin32Error() != 1168) throw new Exception("CredDelete failed"); }',
      "}",
    ],
    remove ? `[AmoCredW]::Delete(${psQuote(target)})` : `[AmoCredW]::Write(${psQuote(target)}, ([string]$env:${SECRET_ENV}).Trim())`,
  );
}

/**
 * Windows Credential Manager. Reads are cached for the life of the process; a write or removal refreshes the cache.
 * `preload()` (the Host awaits it before it serves) reads every entry in one PowerShell run that does not hold up the
 * event loop; after it, reads never start PowerShell (2026-10-20: each read took 0.7–2 s, blocking the Host).
 */
export class WindowsCredentialReader implements CredentialStore {
  private readonly cache = new Map<string, string | null>();
  /** Every entry is in the cache: one that is not there does not exist. */
  private complete = false;

  /** `prefix` is for tests, which use their own entries. */
  constructor(private readonly prefix = CREDENTIAL_TARGET_PREFIX) {}

  /**
   * Reads all entries under the prefix at once. Resolves when they are in, or after `waitMs` (a slow machine): the
   * run then finishes in the background, and reads meanwhile go to PowerShell one by one, as before; a failure too.
   */
  async preload(waitMs = 3000): Promise<void> {
    if (process.platform !== "win32") return;
    const loaded = new Promise<void>((resolve) => {
      const child = execFile("powershell", POWERSHELL_ARGS, { encoding: "utf8", windowsHide: true, timeout: 20_000 }, (err, stdout) => {
        if (!err) this.fill(stdout);
        resolve();
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(enumerateScript(this.prefix));
    });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([loaded, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
    clearTimeout(timer);
  }

  private fill(out: string): void {
    for (const line of out.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab <= 0) continue;
      const id = line.slice(0, tab);
      if (this.cache.has(id) || !ID_PATTERN.test(id)) continue;
      const secret = Buffer.from(line.slice(tab + 1).trim(), "base64").toString("utf8").trim();
      this.cache.set(id, secret.length ? secret : null);
    }
    this.complete = true;
  }

  read(credentialId: string): string | null {
    if (!ID_PATTERN.test(credentialId)) throw new Error(`invalid credential id: ${credentialId}`);
    if (this.cache.has(credentialId)) return this.cache.get(credentialId)!;
    if (process.platform !== "win32" || this.complete) return null;
    // The script holds only the target name; the secret comes back on stdout.
    const out = this.powershell(readScript(this.prefix + credentialId)).trim();
    const secret = out.length ? out : null;
    this.cache.set(credentialId, secret);
    return secret;
  }

  write(credentialId: string, secret: string): void {
    if (!ID_PATTERN.test(credentialId)) throw new Error(`invalid credential id: ${credentialId}`);
    if (process.platform !== "win32") throw new Error("the Credential Manager is only available on Windows");
    this.powershell(writeScript(this.prefix + credentialId, false), secret);
    this.cache.set(credentialId, secret.trim());
  }

  remove(credentialId: string): void {
    if (!ID_PATTERN.test(credentialId)) throw new Error(`invalid credential id: ${credentialId}`);
    if (process.platform !== "win32") return;
    this.powershell(writeScript(this.prefix + credentialId, true));
    this.cache.set(credentialId, null);
  }

  private powershell(script: string, secret?: string): string {
    return execFileSync("powershell", POWERSHELL_ARGS, {
      encoding: "utf8",
      windowsHide: true,
      input: script,
      ...(secret === undefined ? { stdio: ["pipe", "pipe", "ignore"] } : { env: { ...process.env, [SECRET_ENV]: secret }, stdio: ["pipe", "pipe", "pipe"] }),
    });
  }
}

/** Secrets in memory, for tests. */
export class StaticCredentialReader implements CredentialStore {
  constructor(private readonly secrets: Record<string, string>) {}
  read(credentialId: string): string | null {
    return this.secrets[credentialId] ?? null;
  }
  write(credentialId: string, secret: string): void {
    this.secrets[credentialId] = secret.trim();
  }
  remove(credentialId: string): void {
    delete this.secrets[credentialId];
  }
}
