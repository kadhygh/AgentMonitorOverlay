import { CANVAS_COLORS, type CanvasColor } from "@amo-studio/protocol";
import { ContextMenu } from "../lib/ContextMenu.js";

// The canvas's right-click menu (stage 16, after Obsidian Canvas): one for the empty canvas, a card, a note, a group
// or a dependency line. Items, separators and a row of colour marks; it closes on a pick or as every menu does
// (lib/ContextMenu.tsx: Escape, a click elsewhere, the wheel, the window losing focus) and stays inside the window.

export type MenuEntry =
  | { kind: "item"; label: string; onPick(): void; danger?: boolean; disabled?: boolean; hint?: string; testId?: string }
  | { kind: "colors"; value: CanvasColor | undefined; onPick(color: CanvasColor | null): void }
  | { kind: "sep" };

export const item = (label: string, onPick: () => void, more: { danger?: boolean; disabled?: boolean; hint?: string; testId?: string } = {}): MenuEntry => ({ kind: "item", label, onPick, ...more });
export const SEP: MenuEntry = { kind: "sep" };

export function CanvasMenu({ x, y, label, entries, onClose }: { x: number; y: number; label: string; entries: readonly MenuEntry[]; onClose(): void }) {
  return (
    <ContextMenu at={{ x, y }} label={label} onClose={onClose} className="canvas-menu" testId="canvas-menu">
      {entries.map((e, i) => {
        if (e.kind === "sep") return <div key={`sep${i}`} className="menu-sep" role="separator" />;
        if (e.kind === "colors") {
          return (
            <div key="colors" className="canvas-menu-colors" role="group" aria-label="标记颜色">
              {CANVAS_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={e.value === c.id}
                  aria-label={`标${c.label}色`}
                  title={`标${c.label}色`}
                  className="color-swatch"
                  data-color={c.id}
                  onClick={() => {
                    onClose();
                    e.onPick(e.value === c.id ? null : c.id);
                  }}
                />
              ))}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!e.value}
                aria-label="不标颜色"
                title="不标颜色"
                className="color-swatch none"
                onClick={() => {
                  onClose();
                  e.onPick(null);
                }}
              />
            </div>
          );
        }
        return (
          <button
            key={e.label}
            type="button"
            role="menuitem"
            className={e.danger ? "menu-danger" : undefined}
            disabled={e.disabled}
            title={e.hint}
            data-testid={e.testId}
            onClick={() => {
              onClose();
              e.onPick();
            }}
          >
            {e.label}
          </button>
        );
      })}
    </ContextMenu>
  );
}
