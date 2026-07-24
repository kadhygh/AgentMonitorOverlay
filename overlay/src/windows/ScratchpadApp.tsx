import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { StickyNote, Trash2, X } from "lucide-react";
import {
  loadCliSafePasteEnabled,
  toCliPasteClipboardText,
  writeClipboardText,
} from "../native/clipboard";
import { useAmoThemeRuntime } from "../theme/amoTheme";

const SCRATCHPAD_TEXT_STORAGE_KEY = "amo.scratchpad.text";
const SCRATCHPAD_ACTIVE_PAGE_STORAGE_KEY = "amo.scratchpad.activePage";
const SCRATCHPAD_PAGE_COUNT = 3;
const SCRATCHPAD_SAVE_DELAY_MS = 500;

function scratchpadPageStorageKey(pageIndex: number) {
  return `${SCRATCHPAD_TEXT_STORAGE_KEY}.${pageIndex + 1}`;
}

function normalizeScratchpadPage(value: string | null) {
  const page = Number(value);
  return Number.isInteger(page) && page >= 0 && page < SCRATCHPAD_PAGE_COUNT ? page : 0;
}

function loadScratchpadPageText(pageIndex: number) {
  const pageText = localStorage.getItem(scratchpadPageStorageKey(pageIndex));
  if (pageText !== null) {
    return pageText;
  }

  return pageIndex === 0 ? localStorage.getItem(SCRATCHPAD_TEXT_STORAGE_KEY) || "" : "";
}

function saveScratchpadPageText(pageIndex: number, text: string) {
  localStorage.setItem(scratchpadPageStorageKey(pageIndex), text);
  if (pageIndex === 0) {
    localStorage.removeItem(SCRATCHPAD_TEXT_STORAGE_KEY);
  }
}

export function ScratchpadApp() {
  useAmoThemeRuntime();

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activePageRef = useRef(0);
  const pendingTextRef = useRef(new Map<number, string>());
  const saveTimersRef = useRef(new Map<number, number>());
  const [activePage, setActivePage] = useState(() =>
    normalizeScratchpadPage(localStorage.getItem(SCRATCHPAD_ACTIVE_PAGE_STORAGE_KEY)),
  );
  const [textLength, setTextLength] = useState(0);
  const [status, setStatus] = useState("Ready");

  activePageRef.current = activePage;

  function flushPageText(pageIndex: number) {
    const pendingText = pendingTextRef.current.get(pageIndex);
    if (pendingText === undefined) return;

    const timer = saveTimersRef.current.get(pageIndex);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      saveTimersRef.current.delete(pageIndex);
    }
    pendingTextRef.current.delete(pageIndex);
    saveScratchpadPageText(pageIndex, pendingText);
  }

  function queuePageTextSave(pageIndex: number, text: string) {
    pendingTextRef.current.set(pageIndex, text);
    const previousTimer = saveTimersRef.current.get(pageIndex);
    if (previousTimer !== undefined) {
      window.clearTimeout(previousTimer);
    }

    const timer = window.setTimeout(() => {
      flushPageText(pageIndex);
      if (activePageRef.current === pageIndex) {
        setStatus("Saved");
      }
    }, SCRATCHPAD_SAVE_DELAY_MS);
    saveTimersRef.current.set(pageIndex, timer);
  }

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const savedText = pendingTextRef.current.get(activePage) ?? loadScratchpadPageText(activePage);
    textarea.value = savedText;
    setTextLength(savedText.length);
    localStorage.setItem(SCRATCHPAD_ACTIVE_PAGE_STORAGE_KEY, String(activePage));
    setStatus(`Page ${activePage + 1} ready`);
    window.setTimeout(() => textarea.focus(), 30);
  }, [activePage]);

  useEffect(() => {
    return () => {
      for (const pageIndex of pendingTextRef.current.keys()) {
        flushPageText(pageIndex);
      }
    };
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

  function captureCurrentText() {
    const text = textareaRef.current?.value || "";
    queuePageTextSave(activePage, text);
    setTextLength(text.length);
    return text;
  }

  function switchPage(nextPage: number) {
    if (nextPage === activePage) {
      textareaRef.current?.focus();
      return;
    }

    captureCurrentText();
    setActivePage(nextPage);
  }

  async function copyText() {
    const text = captureCurrentText();
    if (!/\S/.test(text)) {
      setStatus("Nothing to copy");
      textareaRef.current?.focus();
      return;
    }

    try {
      const clipboardText = toCliPasteClipboardText(text, loadCliSafePasteEnabled());
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
  }, [activePage]);

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
    captureCurrentText();
    setStatus("Cleared; Ctrl+Z can restore while focused");
  }

  return (
    <main className="scratchpad-shell">
      <header className="scratchpad-header" data-tauri-drag-region>
        <div data-tauri-drag-region>
          <StickyNote size={15} aria-hidden="true" />
          <strong>AMO Scratchpad</strong>
        </div>
        <nav className="scratchpad-pages" aria-label="Scratchpad pages">
          {Array.from({ length: SCRATCHPAD_PAGE_COUNT }, (_, index) => (
            <button
              type="button"
              key={index}
              className={`scratchpad-page-button ${index === activePage ? "is-active" : ""}`}
              title={`Scratchpad page ${index + 1}`}
              aria-label={`Scratchpad page ${index + 1}`}
              aria-pressed={index === activePage}
              onClick={() => switchPage(index)}
            >
              {index + 1}
            </button>
          ))}
        </nav>
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
          captureCurrentText();
          setStatus("Saving...");
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
