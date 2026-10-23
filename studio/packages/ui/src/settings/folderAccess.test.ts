import { describe, expect, it } from "vitest";
import type { FolderAccessStatus } from "@amo-studio/protocol";
import { folderDetail } from "./FolderAccessDialog.js";

const base: FolderAccessStatus = { workspaceId: "ws-1", name: "mining", path: "G:\\PROJECT\\mining", state: "unprepared" };
const now = new Date("2026-10-23T12:00:00Z");

describe("DSH 沙箱权限 rows", () => {
  it("says what is missing, what was scanned, or what runs", () => {
    expect(folderDetail({ ...base, fullControl: false }, now)).toMatch(/缺可继承的完全控制/);
    expect(folderDetail({ ...base, fullControl: true }, now)).toBe("还没处理项目里的 exe");
    expect(folderDetail({ ...base, state: "ready", exes: 183, scannedAt: "2026-10-23T11:55:00Z" }, now)).toBe("183 个 exe / dll 已设回正常 · 5 分钟前扫描");
    expect(folderDetail({ ...base, state: "running", job: "scan" }, now)).toBe("正在扫描 exe…");
    expect(folderDetail({ ...base, state: "running", job: "setup" }, now)).toMatch(/正在设置/);
    expect(folderDetail({ ...base, state: "failed", error: "Access is denied." }, now)).toBe("Access is denied.");
  });
});
