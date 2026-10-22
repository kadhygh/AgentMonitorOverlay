import { MAX_VIEW_ITEMS, VIEW_KINDS, VIEW_MERGE_MS, viewItemLabel, type GitFileDiff, type Id, type ViewItem, type ViewItemInput, type ViewOpenResult, type ViewPack } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { VIEW_KIND_MODULES } from "./kinds/index.js";
import { kindContext, optionalText, type ViewKindModule } from "./kinds/kind.js";

/**
 * 查看包 (2026-10-23): an agent hands the person files and changes to look at in one go (view_open); the workbench
 * shows the pack in the viewer window, a list beside a preview. Each item's kind checks it (kinds/). The same session
 * sending again within a few seconds adds to the pack it just sent — an agent opening a then b gets one window with
 * both, not b over a.
 */
export class ViewPacksFeature extends Feature {
  get(id: Id): ViewPack {
    const pack = this.store.getViewPack(id);
    if (!pack) throw new HostError("not_found", `查看包 ${id} not found`);
    return pack;
  }

  /** The packs a session sent, newest first. */
  list(sessionId: unknown): ViewPack[] {
    if (typeof sessionId !== "string" || !sessionId) throw new HostError("bad_request", "sessionId is required");
    return this.store.listViewPacks(sessionId);
  }

  /**
   * Checks the items, makes the pack (or adds to the session's pack of a moment ago) and asks the workbench to show it.
   * `sessionId` is the caller's identity when an agent sends it; over HTTP it may be given in the body.
   */
  async open(input: unknown, from: { sessionId?: Id | null } = {}): Promise<ViewOpenResult> {
    if (!this.host.liveWindows) throw new HostError("conflict", "AMO Studio 的窗口没有打开：先启动 AMO Studio，再给人看");
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const sessionId = from.sessionId ?? (typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null);
    const session = sessionId ? this.store.getSession(sessionId) : undefined;
    if (sessionId && !session) throw new HostError("not_found", `session ${sessionId} not found`);
    const workspaceId = typeof body.workspaceId === "string" && body.workspaceId ? body.workspaceId : session?.workspaceId;
    if (!workspaceId) throw new HostError("bad_request", "workspaceId is required (a project from project_context)");
    const workspace = this.requireLiveWorkspace(workspaceId);
    const raw = body.items;
    if (!Array.isArray(raw) || !raw.length || raw.length > MAX_VIEW_ITEMS) throw new HostError("bad_request", `items must be a list of 1 to ${MAX_VIEW_ITEMS}`);
    const ctx = kindContext(workspace);
    const items: Array<Omit<ViewItem, "id">> = [];
    for (const [i, entry] of raw.entries()) {
      const item = entry && typeof entry === "object" ? (entry as ViewItemInput) : ({} as ViewItemInput);
      const module = VIEW_KIND_MODULES[item.kind] as ViewKindModule | undefined;
      if (!module) throw new HostError("bad_request", `items[${i}].kind must be one of: ${VIEW_KINDS.join(", ")}`);
      try {
        items.push(await module.check(item, ctx));
      } catch (err) {
        if (err instanceof HostError) throw new HostError(err.code, `items[${i}]: ${err.message}`);
        throw err;
      }
    }
    const title = optionalText(body.title, "title", 120);
    const now = new Date();
    const at = now.toISOString();

    // The same session's pack of a moment ago, in the same project: these items join it.
    const [latest] = sessionId ? this.store.listViewPacks(sessionId, 1) : [];
    if (latest && latest.workspaceId === workspace.id && now.getTime() - Date.parse(latest.updatedAt) < VIEW_MERGE_MS) {
      const list = [...latest.items];
      let first: Id | null = null;
      for (const next of items) {
        const module = VIEW_KIND_MODULES[next.kind] as ViewKindModule;
        const at_ = list.findIndex((prev) => prev.kind === next.kind && module.merge(prev as never, next as never));
        if (at_ >= 0) list[at_] = module.merge(list[at_] as never, next as never)!;
        else list.push({ ...next, id: newId("vi") } as ViewItem);
        first ??= list[at_ >= 0 ? at_ : list.length - 1]!.id;
      }
      if (list.length > MAX_VIEW_ITEMS) throw new HostError("bad_request", `a pack holds at most ${MAX_VIEW_ITEMS} items`);
      const pack: ViewPack = { ...latest, ...(title ? { title } : {}), items: list, updatedAt: at };
      return { pack: this.save(pack, first), merged: true };
    }
    const withIds = items.map((item) => ({ ...item, id: newId("vi") }) as ViewItem);
    const pack: ViewPack = {
      id: newId("vp"),
      workspaceId: workspace.id,
      sessionId: sessionId ?? null,
      title: title ?? (withIds.length === 1 ? viewItemLabel(withIds[0]!) : `${withIds.length} 项`),
      items: withIds,
      createdAt: at,
      updatedAt: at,
    };
    return { pack: this.save(pack, withIds[0]!.id), merged: false };
  }

  /** An item shown as a diff the Host works out (a proposal). */
  async diff(packId: Id, itemId: Id): Promise<GitFileDiff> {
    const pack = this.get(packId);
    const item = pack.items.find((i) => i.id === itemId);
    if (!item) throw new HostError("not_found", `item ${itemId} not found in 查看包 ${packId}`);
    const module = VIEW_KIND_MODULES[item.kind] as ViewKindModule;
    if (!module.diff) throw new HostError("bad_request", `a ${item.kind} item has no diff of its own`);
    return module.diff(item as never, kindContext(this.requireWorkspace(pack.workspaceId)));
  }

  /** Stores the pack and asks the workbench to show it at `itemId` (what this open added or joined). */
  private save(pack: ViewPack, itemId: Id | null): ViewPack {
    this.store.putViewPack(pack);
    this.publish({ type: "viewpack.upserted", pack });
    this.publish({ type: "viewpack.open", packId: pack.id, at: pack.updatedAt, ...(itemId ? { itemId } : {}) });
    return pack;
  }
}
