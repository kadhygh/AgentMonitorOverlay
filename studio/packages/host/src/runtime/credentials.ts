import { execFileSync } from "node:child_process";

// Access to API keys that old AMO stored in the Windows Credential Manager under
// `AgentMonitorOverlay/model-provider/<id>` (UTF-8 blob). Keys never leave memory except as child-process env vars.
// Studio only reads them; the one entry it writes is the Claude subscription token the person saves in 设置 → 模型凭据
// (HostService keeps that list). The secret reaches PowerShell on stdin, never on its command line.

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

function readScript(target: string): string {
  return `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class AmoCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CRED { public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredReadW(string t, int type, int f, out IntPtr c);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);
  public static string Read(string t) { IntPtr p; if (!CredReadW(t, 1, 0, out p)) return "";
    var c = (CRED)Marshal.PtrToStructure(p, typeof(CRED));
    var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
    CredFree(p); return System.Text.Encoding.UTF8.GetString(b); }
}
"@
[Console]::Out.Write([AmoCred]::Read('${target}'))
`;
}

// Saves the secret read from stdin as a generic credential (UTF-8 blob, like old AMO's entries), or deletes the entry.
function writeScript(target: string, remove: boolean): string {
  return `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class AmoCredW {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CRED { public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWriteW(ref CRED c, int f);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDeleteW(string t, int type, int f);
  public static void Write(string t, string secret) {
    var b = System.Text.Encoding.UTF8.GetBytes(secret);
    var c = new CRED(); c.Type = 1; c.TargetName = t; c.UserName = "amo-studio"; c.Persist = 2;
    c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocHGlobal(b.Length);
    try { Marshal.Copy(b, 0, c.CredentialBlob, b.Length); if (!CredWriteW(ref c, 0)) throw new Exception("CredWrite failed: " + Marshal.GetLastWin32Error()); }
    finally { Marshal.FreeHGlobal(c.CredentialBlob); } }
  public static void Delete(string t) { if (!CredDeleteW(t, 1, 0) && Marshal.GetLastWin32Error() != 1168) throw new Exception("CredDelete failed"); }
}
"@
${remove ? `[AmoCredW]::Delete('${target}')` : `[AmoCredW]::Write('${target}', [Console]::In.ReadToEnd().Trim())`}
`;
}

/** Windows Credential Manager. Reads are cached for the life of the process; a write or removal refreshes the cache. */
export class WindowsCredentialReader implements CredentialStore {
  private readonly cache = new Map<string, string | null>();

  /** `prefix` is for tests, which use their own entries. */
  constructor(private readonly prefix = CREDENTIAL_TARGET_PREFIX) {}

  read(credentialId: string): string | null {
    if (!ID_PATTERN.test(credentialId)) throw new Error(`invalid credential id: ${credentialId}`);
    if (this.cache.has(credentialId)) return this.cache.get(credentialId)!;
    if (process.platform !== "win32") return null;
    // -EncodedCommand keeps the multi-line here-string intact (stdin mode runs line by line and breaks it).
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

  private powershell(script: string, stdin?: string): string {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      encoding: "utf8",
      windowsHide: true,
      ...(stdin === undefined ? { stdio: ["ignore", "pipe", "ignore"] } : { input: stdin, stdio: ["pipe", "pipe", "pipe"] }),
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
