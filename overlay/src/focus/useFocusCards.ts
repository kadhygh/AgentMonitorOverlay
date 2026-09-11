import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadFocusCards } from "../api/focusPanelClient";
import { mergeCard, mergeSnapshot, type FocusCardView, type TaskGroup } from "./model";

export function useFocusCards() {
  const [cards, setCards] = useState<FocusCardView[]>([]);
  const [groups, setGroups] = useState<TaskGroup[]>([]);
  const [groupRevision, setGroupRevision] = useState(0);
  const [reviewGroupId, setReviewGroupId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(true);
  const refreshRef = useRef<() => void>(() => undefined);
  const mutationVersion = useRef(0);
  useEffect(() => {
    let hidden = true, disposed = false, refreshAgain = false, visibilityVersion = 0, timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined, unlisten: (() => void) | undefined;
    const isVisible = () => !hidden && document.visibilityState !== "hidden";
    const refresh = async () => {
      if (disposed || !isVisible()) return;
      if (controller) { refreshAgain = true; return; }
      clearTimeout(timer); const current = new AbortController(); controller = current;
      const version = mutationVersion.current;
      try {
        const result = await loadFocusCards(current.signal);
        if (!disposed && !current.signal.aborted && version === mutationVersion.current) { setCards(previous => mergeSnapshot(previous, result.cards)); setGroups(result.groups); setGroupRevision(result.groupRevision); setReviewGroupId(result.reviewGroupId); setError(""); }
      } catch (reason) { if (!disposed && !current.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not refresh tasks"); }
      finally { controller = undefined; if (!disposed) { setLoading(false); if (isVisible()) { const delay = refreshAgain ? 0 : 4000; refreshAgain = false; timer = setTimeout(() => void refresh(), delay); } } }
    };
    refreshRef.current = () => void refresh();
    const visibilityChanged = () => {
      setVisible(isVisible());
      if (isVisible()) void refresh(); else { clearTimeout(timer); controller?.abort(); }
    };
    const initializeVisibility = async () => {
      try {
        const fn = await listen<boolean>("amo-focus-visibility", event => { visibilityVersion++; hidden = !event.payload; visibilityChanged(); });
        if (disposed) { fn(); return; }
        unlisten = fn;
      } catch { /* Browser previews can still use document visibility. */ }
      const version = visibilityVersion;
      let currentVisible = true;
      try { currentVisible = await getCurrentWindow().isVisible(); } catch { /* No native window in previews. */ }
      if (!disposed && version === visibilityVersion) { hidden = !currentVisible; visibilityChanged(); }
    };
    document.addEventListener("visibilitychange", visibilityChanged); window.addEventListener("focus", visibilityChanged);
    void initializeVisibility();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); unlisten?.(); document.removeEventListener("visibilitychange", visibilityChanged); window.removeEventListener("focus", visibilityChanged); };
  }, []);
  return { cards, groups, groupRevision, reviewGroupId, loading, error, visible, refresh: () => { mutationVersion.current++; refreshRef.current(); }, acceptCard: (card: FocusCardView) => { mutationVersion.current++; setCards(previous => mergeCard(previous, card)); } };
}
