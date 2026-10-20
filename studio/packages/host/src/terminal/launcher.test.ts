import { describe, expect, it } from "vitest";
import { windowsStartLine } from "./launcher.js";

// "Windows 找不到文件 'Studio'" (2026-10-20): Node's `\"` quoting split the window title into a title and a program.
describe("windowsStartLine", () => {
  it("quotes the title once for cmd and hands PowerShell its command encoded", () => {
    const command = `& 'C:/x/claude.exe' --permission-mode default; "100%"`;
    const line = windowsStartLine({ command, cwd: "G:/PROJECT/repo", title: 'AMO Studio 维护 · "Claude" 50%', track: false });
    expect(line.startsWith(`/d /c start "AMO Studio 维护 · Claude 50" /D "G:/PROJECT/repo" powershell.exe -NoExit -NoLogo -EncodedCommand `)).toBe(true);
    expect(Buffer.from(line.split(" ").pop()!, "base64").toString("utf16le")).toBe(command);
  });

  it("waits on a tracked terminal and keeps no shell open after the command", () => {
    const line = windowsStartLine({ command: "exit", cwd: "C:/w", title: "", track: true });
    expect(line).toMatch(/^\/d \/c start "AMO Studio" \/WAIT \/D "C:\/w" powershell\.exe -NoLogo -EncodedCommand \S+$/);
  });
});
