import { useEffect, useState } from "react";

// Focus 桌宠的皮肤 (2026-10-15 evening): the pixel robot (default), 「看书的 Claude 娘」, or 「AMO 娘」 (10-26, mascot.ts),
// whose faces also take over the icons. Chosen in 设置 → 界面, kept per machine in localStorage, which the workbench,
// Focus and the flying robot's window share (same origin), so a change shows everywhere at once through `storage` events.

export type PetSkin = "robot" | "reader" | "mascot";
export const PET_SKINS: Record<PetSkin, string> = { robot: "像素机器人", reader: "看书的 Claude 娘", mascot: "AMO 娘（图标跟着变）" };

const KEY = "amo.focusPet";
const LOCAL_EVENT = "amo:focus-pet";

export function readPetSkin(): PetSkin {
  try {
    const v = localStorage.getItem(KEY);
    return v === "reader" || v === "mascot" ? v : "robot";
  } catch {
    return "robot";
  }
}

export function writePetSkin(skin: PetSkin): void {
  try {
    localStorage.setItem(KEY, skin);
  } catch {
    // a per-machine choice only
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LOCAL_EVENT));
}

/** The chosen skin, following changes made in any Studio window. */
export function usePetSkin(): PetSkin {
  const [skin, setSkin] = useState(readPetSkin);
  useEffect(() => {
    const follow = () => setSkin(readPetSkin());
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY || e.key === null) follow();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(LOCAL_EVENT, follow);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(LOCAL_EVENT, follow);
    };
  }, []);
  return skin;
}
