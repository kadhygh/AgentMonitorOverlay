import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Palette, Settings2, StickyNote, X } from "lucide-react";
import {
  applyScratchpadShortcutState,
  loadScratchpadShortcutState,
  saveScratchpadShortcutState,
  type ScratchpadShortcutState,
} from "../native/scratchpadShortcut";
import { type AmoTheme, useAmoThemeRuntime } from "../theme/amoTheme";
import type { OpenPathResult } from "../types";
import {
  closeUtilityWindow,
  startUtilityWindowDrag,
  useUtilityWindowLifecycle,
} from "./utilityWindow";

export type SettingsSection = "scratchpad" | "theme";

interface SettingsSidebarProps {
  settingsSection: SettingsSection;
  onSettingsSectionChange: (section: SettingsSection) => void;
}

export function SettingsSidebar({ settingsSection, onSettingsSectionChange }: SettingsSidebarProps) {
  return (
    <aside className="settings-sidebar" aria-label="Settings sections">
      <strong>Sections</strong>
      <button
        type="button"
        className={`settings-nav-button ${settingsSection === "scratchpad" ? "is-active" : ""}`}
        onClick={() => onSettingsSectionChange("scratchpad")}
      >
        <StickyNote size={13} aria-hidden="true" />
        <span>Scratchpad</span>
      </button>
      <button
        type="button"
        className={`settings-nav-button ${settingsSection === "theme" ? "is-active" : ""}`}
        onClick={() => onSettingsSectionChange("theme")}
      >
        <Palette size={13} aria-hidden="true" />
        <span>Theme</span>
      </button>
    </aside>
  );
}

interface SettingsDetailHeaderProps {
  settingsSection: SettingsSection;
  scratchpadShortcut: ScratchpadShortcutState;
  amoTheme: AmoTheme;
}

function SettingsDetailHeader({ settingsSection, scratchpadShortcut, amoTheme }: SettingsDetailHeaderProps) {
  const title = settingsSection === "theme" ? "Theme" : "Scratchpad";
  const status =
    settingsSection === "theme"
      ? amoTheme === "light"
        ? "Light"
        : "Dark"
      : scratchpadShortcut.enabled
        ? "Ctrl + Mouse4"
        : "Disabled";

  return (
    <header className="settings-detail-header">
      <div>
        <strong>{title}</strong>
        <span>{status}</span>
      </div>
    </header>
  );
}

interface ScratchpadSettingsBodyProps {
  scratchpadShortcut: ScratchpadShortcutState;
  onScratchpadShortcutChange: (next: ScratchpadShortcutState) => void;
  onOpenScratchpadNow: () => void;
}

function ScratchpadSettingsBody({
  scratchpadShortcut,
  onScratchpadShortcutChange,
  onOpenScratchpadNow,
}: ScratchpadSettingsBodyProps) {
  return (
    <div className="settings-section-body">
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={scratchpadShortcut.enabled}
          onChange={(event) =>
            onScratchpadShortcutChange({
              ...scratchpadShortcut,
              enabled: event.currentTarget.checked,
            })
          }
        />
        <span>Enable global shortcut</span>
      </label>

      <label className="settings-field">
        <span>Shortcut</span>
        <select
          value="mouse4"
          disabled
          onChange={(event) =>
            onScratchpadShortcutChange({
              ...scratchpadShortcut,
              button: "mouse4",
            })
          }
        >
          <option value="mouse4">Ctrl + Mouse4</option>
        </select>
      </label>

      <button type="button" className="settings-primary-action" onClick={onOpenScratchpadNow}>
        Open scratchpad now
      </button>
    </div>
  );
}

interface ThemeSettingsBodyProps {
  amoTheme: AmoTheme;
  onAmoThemeChange: (theme: AmoTheme) => void;
}

function ThemeSettingsBody({ amoTheme, onAmoThemeChange }: ThemeSettingsBodyProps) {
  return (
    <div className="settings-section-body">
      <div className="theme-choice-grid">
        <button
          type="button"
          className={`theme-choice ${amoTheme === "dark" ? "is-active" : ""}`}
          onClick={() => onAmoThemeChange("dark")}
        >
          <span className="theme-swatch theme-swatch-dark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <strong>Dark</strong>
          <span>Night workspace</span>
        </button>

        <button
          type="button"
          className={`theme-choice ${amoTheme === "light" ? "is-active" : ""}`}
          onClick={() => onAmoThemeChange("light")}
        >
          <span className="theme-swatch theme-swatch-light" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <strong>Light</strong>
          <span>Day workspace</span>
        </button>
      </div>
    </div>
  );
}

interface SettingsDetailProps {
  settingsSection: SettingsSection;
  scratchpadShortcut: ScratchpadShortcutState;
  amoTheme: AmoTheme;
  onScratchpadShortcutChange: (next: ScratchpadShortcutState) => void;
  onOpenScratchpadNow: () => void;
  onAmoThemeChange: (theme: AmoTheme) => void;
}

export function SettingsDetail({
  settingsSection,
  scratchpadShortcut,
  amoTheme,
  onScratchpadShortcutChange,
  onOpenScratchpadNow,
  onAmoThemeChange,
}: SettingsDetailProps) {
  return (
    <div className="settings-detail">
      <SettingsDetailHeader
        settingsSection={settingsSection}
        scratchpadShortcut={scratchpadShortcut}
        amoTheme={amoTheme}
      />

      {settingsSection === "scratchpad" ? (
        <ScratchpadSettingsBody
          scratchpadShortcut={scratchpadShortcut}
          onScratchpadShortcutChange={onScratchpadShortcutChange}
          onOpenScratchpadNow={onOpenScratchpadNow}
        />
      ) : (
        <ThemeSettingsBody amoTheme={amoTheme} onAmoThemeChange={onAmoThemeChange} />
      )}
    </div>
  );
}

export function SettingsWindowApp() {
  useUtilityWindowLifecycle("settings");
  const [amoTheme, setAmoThemePreference] = useAmoThemeRuntime();

  const [settingsSection, setSettingsSection] = useState<SettingsSection>("scratchpad");
  const [scratchpadShortcut, setScratchpadShortcut] = useState<ScratchpadShortcutState>(() =>
    loadScratchpadShortcutState(),
  );
  const [feedback, setFeedback] = useState("Settings ready.");

  async function updateScratchpadShortcut(next: ScratchpadShortcutState) {
    setScratchpadShortcut(next);
    saveScratchpadShortcutState(next);

    try {
      const result = await applyScratchpadShortcutState(next);
      setFeedback(result.message);
    } catch (error) {
      setFeedback(`Scratchpad shortcut update failed: ${(error as Error).message}`);
    }
  }

  async function openScratchpadNow() {
    try {
      const result = await invoke<OpenPathResult>("show_scratchpad_at_cursor");
      setFeedback(result.message);
    } catch (error) {
      setFeedback(`Scratchpad open failed: ${(error as Error).message}`);
    }
  }

  async function updateAmoTheme(next: AmoTheme) {
    await setAmoThemePreference(next);
    setFeedback(`Theme set to ${next === "light" ? "Light" : "Dark"}.`);
  }

  return (
    <main className="utility-window-shell settings-window-shell">
      <section className="app-dialog settings-dialog" role="dialog" aria-label="AMO settings">
        <header className="app-dialog-titlebar">
          <div className="app-dialog-title" onPointerDown={startUtilityWindowDrag}>
            <Settings2 size={16} aria-hidden="true" />
            <div>
              <strong>Settings</strong>
              <span>AMO workspace and utility preferences</span>
            </div>
          </div>
          <button
            type="button"
            className="candidate-close"
            title="Close settings"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void closeUtilityWindow("settings");
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </header>

        <SettingsSidebar settingsSection={settingsSection} onSettingsSectionChange={setSettingsSection} />

        <SettingsDetail
          settingsSection={settingsSection}
          scratchpadShortcut={scratchpadShortcut}
          amoTheme={amoTheme}
          onScratchpadShortcutChange={(next) => void updateScratchpadShortcut(next)}
          onOpenScratchpadNow={() => void openScratchpadNow()}
          onAmoThemeChange={(next) => void updateAmoTheme(next)}
        />

        <footer className="app-dialog-footer">
          <span title={feedback}>{feedback}</span>
        </footer>
      </section>
    </main>
  );
}
