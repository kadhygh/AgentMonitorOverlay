import { useEffect, useState } from "react";
import type { Session } from "@amo-studio/protocol";
import { unseenSessions, type SeenData } from "../lib/sessionSeen.js";
import type { BotMood } from "./PixelBot.js";
import { usePetSkin } from "./petSkin.js";

// 「AMO 娘」 (2026-10-26): the 桌宠 skin drawn with the blue mascot's faces (design/icon/mascot-blue). Chosen, the icons
// follow the work too — top left of the workbench, Focus's title, the taskbar button — as the person laid out:
// 出错 / 等审批 → 待命 (01), 没额度 → 睿智 (06), 在跑 → 认真 (03), 只剩等审核 → 开心 (02), nothing → the plain icon.

export type MascotFace = "idle" | "happy" | "focused" | "wink" | "angry" | "goofy";

/** The file of each face, in ui/public/mascot and app/assets/mascot (scripts/make-icons.mjs). */
export const MASCOT_FILES: Record<MascotFace, string> = {
  idle: "01-idle",
  happy: "02-happy",
  focused: "03-focused",
  wink: "04-wink",
  angry: "05-angry",
  goofy: "06-goofy",
};

export const mascotSrc = (face: MascotFace) => `./mascot/${MASCOT_FILES[face]}.png`;

/** The pet's face for its mood: something needs the person, only finished work, or left waiting too long. */
export const PET_FACE: Record<BotMood, MascotFace> = { alert: "idle", calm: "happy", angry: "angry" };

/** What the icons show for these sessions, or null for the plain icon. The first that holds wins. */
export function mascotFace(sessions: readonly Session[], seen: SeenData): MascotFace | null {
  const live = sessions.filter((s) => !s.archivedAt);
  const unseen = unseenSessions(sessions, seen);
  if (unseen.some((s) => s.status === "error")) return "idle";
  if (live.some((s) => s.status === "awaiting-approval" || s.status === "awaiting-answer")) return "idle";
  if (live.some((s) => !!s.wake?.limit)) return "goofy";
  if (live.some((s) => s.status === "running")) return "focused";
  if (live.some((s) => s.status === "awaiting-review") || unseen.length > 0) return "happy";
  return null;
}

/** How long a face must hold before the icons take it: sessions pass through states in a moment. */
export const MASCOT_SETTLE_MS = 1500;

/**
 * The face the icons show for these sessions: null for the plain icon, or while another pet is chosen. It changes once
 * it has held for MASCOT_SETTLE_MS.
 */
export function useMascotFace(sessions: readonly Session[] | null, seen: SeenData): MascotFace | null {
  const skin = usePetSkin();
  return useSettledFace(skin === "mascot" && sessions ? mascotFace(sessions, seen) : null);
}

/** `face` once it has held for MASCOT_SETTLE_MS (at once the first time). */
export function useSettledFace(face: MascotFace | null): MascotFace | null {
  const [settled, setSettled] = useState(face);
  useEffect(() => {
    if (face === settled) return;
    const t = setTimeout(() => setSettled(face), MASCOT_SETTLE_MS);
    return () => clearTimeout(t);
  }, [face, settled]);
  return settled;
}
