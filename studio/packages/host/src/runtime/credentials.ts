import { execFileSync } from "node:child_process";

// Read-only access to API keys that old AMO stored in the Windows Credential Manager under
// `AgentMonitorOverlay/model-provider/<id>` (UTF-8 blob). Keys never leave memory except as child-process env vars.

export interface CredentialReader {
  /** The secret, or null when the entry does not exist. */
  read(credentialId: string): string | null;
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

/** Windows Credential Manager reader. Results are cached for the life of the process. */
export class WindowsCredentialReader implements CredentialReader {
  private readonly cache = new Map<string, string | null>();

  read(credentialId: string): string | null {
    if (!ID_PATTERN.test(credentialId)) throw new Error(`invalid credential id: ${credentialId}`);
    if (this.cache.has(credentialId)) return this.cache.get(credentialId)!;
    if (process.platform !== "win32") return null;
    // -EncodedCommand keeps the multi-line here-string intact (stdin mode runs line by line and breaks it).
    // The script holds only the target name; the secret comes back on stdout.
    const encoded = Buffer.from(readScript(CREDENTIAL_TARGET_PREFIX + credentialId), "utf16le").toString("base64");
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const secret = out.length ? out : null;
    this.cache.set(credentialId, secret);
    return secret;
  }
}

/** Fixed secrets for tests. */
export class StaticCredentialReader implements CredentialReader {
  constructor(private readonly secrets: Record<string, string>) {}
  read(credentialId: string): string | null {
    return this.secrets[credentialId] ?? null;
  }
}
