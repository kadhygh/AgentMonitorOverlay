import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { StickyNote, Trash2, X } from "lucide-react";
import { toCliPasteClipboardText, writeClipboardText } from "../native/clipboard";
import { useAmoThemeRuntime } from "../theme/amoTheme";

const SCRATCHPAD_TEXT_STORAGE_KEY = "amo.scratchpad.text";

export function ScratchpadApp() {
  useAmoThemeRuntime();

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [textLength, setTextLength] = useState(0);
  const [status, setStatus] = useState("Ready");

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const savedText = localStorage.getItem(SCRATCHPAD_TEXT_STORAGE_KEY) || "";
    textarea.value = savedText;
    setTextLength(savedText.length);
    window.setTimeout(() => textarea.focus(), 30);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      void getCurrentWindow().hide();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  function persistCurrentText() {
    const text = textareaRef.current?.value || "";
    localStorage.setItem(SCRATCHPAD_TEXT_STORAGE_KEY, text);
    setTextLength(text.length);
    return text;
  }

  async function copyText() {
    const text = persistCurrentText();
    if (!text.trim()) {
      setStatus("Nothing to copy");
      textareaRef.current?.focus();
      return;
    }

    try {
      const clipboardText = toCliPasteClipboardText(text);
      const result = await writeClipboardText(clipboardText);
      setStatus(result.ok ? "Copied" : result.message);
      if (result.ok) {
        await getCurrentWindow().hide();
      }
    } catch (error) {
      setStatus(`Copy failed: ${(error as Error).message}`);
    } finally {
      textareaRef.current?.focus();
    }
  }

  useEffect(() => {
    let disposed = false;
    let unlistenCopyRequest: (() => void) | null = null;

    void listen("scratchpad-copy-request", () => {
      if (document.activeElement !== textareaRef.current) {
        textareaRef.current?.focus();
        return;
      }

      void copyText();
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenCopyRequest = unlisten;
        }
      })
      .catch((error) => {
        setStatus(`Shortcut listener failed: ${(error as Error).message}`);
      });

    return () => {
      disposed = true;
      unlistenCopyRequest?.();
    };
  }, []);

  function clearText() {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.focus();
    textarea.select();
    const deleted = document.execCommand("delete");
    if (!deleted) {
      textarea.value = "";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    persistCurrentText();
    setStatus("Cleared; Ctrl+Z can restore while focused");
  }

  return (
    <main className="scratchpad-shell">
      <header className="scratchpad-header" data-tauri-drag-region>
        <div data-tauri-drag-region>
          <StickyNote size={15} aria-hidden="true" />
          <strong>AMO Scratchpad</strong>
        </div>
        <span className="scratchpad-header-actions">
          <button
            type="button"
            className="scratchpad-clear-button"
            title="Clear scratchpad"
            aria-label="Clear scratchpad"
            onClick={clearText}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
          <button type="button" title="Close" aria-label="Close scratchpad" onClick={() => void getCurrentWindow().hide()}>
            <X size={14} aria-hidden="true" />
          </button>
        </span>
      </header>
      <textarea
        ref={textareaRef}
        className="scratchpad-input"
        spellCheck={false}
        placeholder="Write the reply points you want to keep while reading..."
        onInput={() => {
          persistCurrentText();
          setStatus("Saved");
        }}
      />
      <footer className="scratchpad-footer">
        <span title={status}>
          {textLength} chars | {status}
        </span>
        <div className="scratchpad-copy-actions">
          <button type="button" onClick={() => void copyText()}>
            Copy
          </button>
        </div>
      </footer>
    </main>
  );
}
