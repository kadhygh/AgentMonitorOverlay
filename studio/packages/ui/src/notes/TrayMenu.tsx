import { useEffect, useState } from "react";
import { useHostState } from "../host/useHostState.js";
import { ScratchpadIcon } from "../scratchpad/ScratchpadApp.js";
import { shortcutLabel } from "../scratchpad/logic.js";
import { notesCall } from "./api.js";

// The 便签 program's tray menu (#notes-tray-menu, 2026-10-23): a small window in AMO's look instead of Windows' rounded
// menu. 显示便签 (with the shortcut as bound) / 设置… / 退出便签; Esc or a click elsewhere closes it.

export function TrayMenu() {
  const host = useHostState();
  const [shortcut, setShortcut] = useState("");
  const act = (action: "show" | "settings" | "quit" | "close") => window.amo?.notes?.trayAction?.(action);

  useEffect(() => {
    if (host.kind !== "ready") return;
    const read = () =>
      void notesCall(host.link, "GET", "")
        .then((info) => setShortcut(info.shortcut.active))
        .catch(() => undefined);
    read();
    // The menu window is made once and shown again each time: read the shortcut again when it comes forward.
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [host]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") act("close");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="tm-root" role="menu" aria-label="便签菜单">
      <div className="tm-title">
        <ScratchpadIcon size={14} />
        AMO 便签
      </div>
      <button type="button" role="menuitem" className="tm-item strong" onClick={() => act("show")}>
        显示便签
        {shortcut && <span className="tm-key">{shortcutLabel(shortcut).split(" + ").join("+")}</span>}
      </button>
      <button type="button" role="menuitem" className="tm-item" onClick={() => act("settings")}>
        设置…
      </button>
      <div className="tm-rule" aria-hidden="true" />
      <button type="button" role="menuitem" className="tm-item" onClick={() => act("quit")}>
        退出便签
      </button>
    </div>
  );
}
