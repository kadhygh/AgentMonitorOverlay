import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isCommon, projectWorkspaces, type DshStatus, type FolderAccessStatus, type Id, type ModelProfile, type Workspace } from "@amo-studio/protocol";
import { DSH_OPTIONS_KEY, DSH_PATH_KEY, DSH_SOURCE_KEY, describeDsh, dshStatus } from "../../runtime/dsh/install.js";
import type { DshRuntime } from "../../runtime/dsh/dsh-runtime.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/**
 * 设置 → 模型 → DeepSeek Harness (stage 17): what DeepSeek · DSH sessions run on — the desktop app when it is installed
 * (2026-10-26), or a source clone (where it is, what version and commit it has, whether it is built) — and 「检查」.
 */
export class DshFeature extends Feature {
  status(): DshStatus {
    return dshStatus(this.store);
  }

  /** 设置's changes: `source` ("auto": the desktop app when installed; "clone") and/or `path` (the clone's folder). */
  update(body: { source?: unknown; path?: unknown }): DshStatus {
    if (body.source !== undefined) {
      if (body.source !== "auto" && body.source !== "clone") throw new HostError("bad_request", 'source must be "auto" or "clone"');
      this.store.setKv(DSH_SOURCE_KEY, body.source);
      if (body.path === undefined) {
        this.store.setKv(DSH_OPTIONS_KEY, "null");
        this.profilesChanged();
        return this.status();
      }
    }
    return this.setPath(body.path);
  }

  /** Sets the clone's folder (null clears it). The DSH profile shows in the pickers once the clone is built. */
  setPath(value: unknown): DshStatus {
    if (value === null || value === "") {
      this.store.setKv(DSH_PATH_KEY, "");
    } else {
      if (typeof value !== "string" || value.length > 1000) throw new HostError("bad_request", "path must be a folder path or null");
      const path = resolve(value.trim());
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new HostError("bad_request", `找不到文件夹 ${path}`);
      if (!describeDsh(path)) throw new HostError("bad_request", `${path} 不是 DSH 源码克隆（里面没有 apps/cli）`);
      this.store.setKv(DSH_PATH_KEY, path);
    }
    // Models of another clone may differ: the next 「检查」 or session tells them again.
    this.store.setKv(DSH_OPTIONS_KEY, "null");
    this.profilesChanged();
    return this.status();
  }

  async check(): Promise<DshStatus> {
    const runtime = this.options.dsh;
    if (!runtime) throw new HostError("read_only", "这个 Host 没有 DSH 运行时");
    await runtime.check();
    this.profilesChanged();
    return this.status();
  }

  /** 「修复文件夹权限」 on a DSH session's notice (2026-10-23): the fix runs on; the notice shows how it went. */
  async fixFolderAccess(sessionId: Id): Promise<{ ok: true }> {
    const runtime = this.options.dsh;
    const session = this.store.getSession(sessionId);
    if (!session) throw new HostError("not_found", `session ${sessionId} not found`);
    if (!runtime || session.runtime !== "dsh") throw new HostError("bad_request", "只有 DSH 会话有这个修复");
    try {
      await runtime.fixFolderAccess(sessionId);
    } catch (err) {
      throw new HostError("bad_request", err instanceof Error ? err.message : String(err));
    }
    return { ok: true };
  }

  /** 设置 → 项目与目录: each project's folder as DSH's write sandbox finds it. */
  async folders(): Promise<{ available: boolean; folders: FolderAccessStatus[] }> {
    const runtime = this.options.dsh;
    if (!runtime?.foldersAvailable) return { available: false, folders: [] };
    // The common space too: tasks without a project run their sessions there.
    const all = this.store.listWorkspaces();
    const list = [...all.filter((w) => isCommon(w)), ...projectWorkspaces(all)];
    const folders = await Promise.all(list.map(async (w) => ({ workspaceId: w.id, name: isCommon(w) ? "公共目录" : w.name, path: w.path, ...(await runtime.folderStatus(w.path)) })));
    return { available: true, folders };
  }

  /** One project's folder (the hint under 工程内写 asks before a DSH session starts there). */
  async folder(workspaceId: Id): Promise<FolderAccessStatus> {
    const { runtime, w } = this.folderTarget(workspaceId);
    return { workspaceId: w.id, name: isCommon(w) ? "公共目录" : w.name, path: w.path, ...(await runtime.folderStatus(w.path)) };
  }

  /** Sets one project's folder up; GET follows it. */
  async setupFolder(workspaceId: Id): Promise<FolderAccessStatus> {
    const { runtime, w } = this.folderTarget(workspaceId);
    runtime.setupFolder(w.path);
    return this.folder(workspaceId);
  }

  /** 恢复原来的权限: undoes the setup on a project's folder; GET follows it. */
  async revertFolder(workspaceId: Id): Promise<FolderAccessStatus> {
    const { runtime, w } = this.folderTarget(workspaceId);
    runtime.revertFolder(w.path);
    return this.folder(workspaceId);
  }

  /** Scans a set-up folder for new .exe files; GET follows it. */
  async scanFolder(workspaceId: Id): Promise<FolderAccessStatus> {
    const { runtime, w } = this.folderTarget(workspaceId);
    try {
      runtime.scanFolder(w.path);
    } catch (err) {
      throw new HostError("bad_request", err instanceof Error ? err.message : String(err));
    }
    return this.folder(workspaceId);
  }

  private folderTarget(workspaceId: Id): { runtime: DshRuntime; w: Workspace } {
    const runtime = this.options.dsh;
    const w = this.store.getWorkspace(workspaceId);
    if (!w || w.archivedAt) throw new HostError("not_found", `project ${workspaceId} not found`);
    if (!runtime?.foldersAvailable) throw new HostError("not_found", "这台机器上 Studio 不处理文件夹权限（只在 Windows 上）");
    return { runtime, w };
  }

  private profilesChanged(): void {
    this.options.channels?.refresh();
    this.publish({ type: "profiles.updated", profiles: [...this.profiles] as ModelProfile[] });
  }
}
