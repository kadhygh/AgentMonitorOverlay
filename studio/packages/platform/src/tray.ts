// The platform's tray menu (plans/remote-page-and-new-task.md §6, 2026-10-29, the user): the tools the platform starts
// put no icon of their own in the tray (`--amo-tray=platform`), so this one menu has all of them — not folded into
// submenus (there are few), one part per tool under a grey heading, everything listed. Clicking the icon opens 便签 or
// Studio, as chosen at the bottom. What an item does is an action the platform runs (platform.ts's trayAction): each
// starts the tool's exe again with an argument its single instance hands to the running one (or that it acts on alone).

export type TrayClick = "notes" | "studio";

export type TrayAction =
  | { kind: "open"; tool: string }
  | { kind: "toggle-notes" }
  | { kind: "quit"; tool: string }
  | { kind: "restart-studio" }
  | { kind: "show-platform" }
  | { kind: "set-click"; to: TrayClick }
  | { kind: "quit-platform" };

export type TrayItem = { kind: "heading"; label: string } | { kind: "item"; label: string; action: TrayAction } | { kind: "radio"; label: string; checked: boolean; action: TrayAction } | { kind: "separator" };

export interface TrayState {
  /** Installed tools, in the platform's order (id and name). */
  tools: ReadonlyArray<{ id: string; name: string }>;
  /** 便签 can be had: installed itself, or through Studio (which carries it). */
  notes: boolean;
  /** Studio's Host is older than the installed Studio and idle: 重启 Studio is offered (platform.ts's studio view). */
  studioRestart: boolean;
  /** The installed Studio's version, for 重启 Studio's label. */
  studioVersion: string | null;
  click: TrayClick;
  /** What waits in AMO 中转 (relay-attention.ts; 0 or absent: nothing): the icon is 中转's then, and a click opens it. */
  relayCount?: number;
}

/** The menu, top to bottom. */
export function trayMenu(s: TrayState): TrayItem[] {
  const out: TrayItem[] = [];
  const part = (heading: string, items: TrayItem[]) => {
    if (out.length) out.push({ kind: "separator" });
    out.push({ kind: "heading", label: heading }, ...items);
  };
  const has = (id: string) => s.tools.some((t) => t.id === id);
  if (has("studio"))
    part("AMO Studio", [
      { kind: "item", label: "打开 Studio", action: { kind: "open", tool: "studio" } },
      ...(s.studioRestart ? [{ kind: "item" as const, label: s.studioVersion ? `重启 Studio（换成 ${s.studioVersion}）` : "重启 Studio", action: { kind: "restart-studio" as const } }] : []),
      { kind: "item", label: "完全退出 Studio", action: { kind: "quit", tool: "studio" } },
    ]);
  if (s.notes)
    part("AMO 便签", [
      { kind: "item", label: "显示 / 隐藏便签", action: { kind: "toggle-notes" } },
      { kind: "item", label: "退出便签", action: { kind: "quit", tool: "notes" } },
    ]);
  if (has("relay"))
    part("AMO 中转", [
      { kind: "item", label: s.relayCount ? `打开中转（${s.relayCount} 条待处理 / 未读）` : "打开中转", action: { kind: "open", tool: "relay" } },
      { kind: "item", label: "退出中转", action: { kind: "quit", tool: "relay" } },
    ]);
  for (const t of s.tools.filter((t) => !["studio", "notes", "relay", "platform"].includes(t.id))) part(t.name, [{ kind: "item", label: `打开 ${t.name.replace(/^AMO /, "")}`, action: { kind: "open", tool: t.id } }]);
  const clicks: TrayItem[] = [];
  if (s.notes) clicks.push({ kind: "radio", label: "单击图标：打开便签", checked: s.click === "notes", action: { kind: "set-click", to: "notes" } });
  if (has("studio")) clicks.push({ kind: "radio", label: "单击图标：打开 Studio", checked: s.click === "studio" || !s.notes, action: { kind: "set-click", to: "studio" } });
  part("AMO 平台", [{ kind: "item", label: "打开 AMO 平台", action: { kind: "show-platform" } }, ...clicks, { kind: "item", label: "退出平台", action: { kind: "quit-platform" } }]);
  return out;
}

/** What a click on the icon does: 中转 while the icon is its (something waits there), else the chosen tool when it can
 *  be had, else the platform's window. */
export function trayClickAction(s: TrayState): TrayAction {
  if (s.relayCount && s.tools.some((t) => t.id === "relay")) return { kind: "open", tool: "relay" };
  if (s.click === "notes" && s.notes) return { kind: "toggle-notes" };
  if (s.tools.some((t) => t.id === "studio") && (s.click === "studio" || !s.notes)) return { kind: "open", tool: "studio" };
  if (s.notes) return { kind: "toggle-notes" };
  return { kind: "show-platform" };
}

/** The arguments the tools take from the platform (each tool reads them itself; constraint 1: they run without it too). */
export const TRAY_ARG = "--amo-tray=platform";
export const QUIT_ARG = "--amo-quit";
export const TOGGLE_ARG = "--amo-toggle";
