import { PacksPage } from "./PacksPage.js";
import type { ViewDef } from "../shell/views.js";

/** A project's extension packs; the tab shows only while one project is in scope. */
export const packsView: ViewDef<"packs"> = {
  kind: "packs",
  feature: "packs",
  tab: { label: "扩展包", open: (scope) => (scope.kind === "workspace" ? { kind: "packs", workspaceId: scope.id } : null) },
  render: (view, { link, state }) => {
    const ws = state.workspaces.find((w) => w.id === view.workspaceId);
    return ws ? <PacksPage key={ws.id} link={link} workspace={ws} profiles={state.profiles} /> : <div className="placeholder">工作区不存在或已被移除。</div>;
  },
};
