import { useEffect, useState } from "react";

// 按专题分组 (2026-10-19): the board's columns hold their cards under their topics, the ones in none last. On unless
// turned off on the board; stored per install.

const GROUP_KEY = "amo.boardGroupTopics";
const GROUP_EVENT = "amo:board-group-topics";

export function groupByTopic(): boolean {
  try {
    return localStorage.getItem(GROUP_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setGroupByTopic(on: boolean): void {
  try {
    localStorage.setItem(GROUP_KEY, on ? "on" : "off");
  } catch {
    // private profile: still applies until reload
  }
  window.dispatchEvent(new CustomEvent(GROUP_EVENT, { detail: on }));
}

/** Whether the board groups by topic, following changes made in this window or another (storage event). */
export function useGroupByTopic(): boolean {
  const [on, setOn] = useState(groupByTopic);
  useEffect(() => {
    const local = (e: Event) => setOn((e as CustomEvent<boolean>).detail);
    const other = (e: StorageEvent) => e.key === GROUP_KEY && setOn(groupByTopic());
    window.addEventListener(GROUP_EVENT, local);
    window.addEventListener("storage", other);
    return () => {
      window.removeEventListener(GROUP_EVENT, local);
      window.removeEventListener("storage", other);
    };
  }, []);
  return on;
}
