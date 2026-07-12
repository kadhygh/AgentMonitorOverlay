import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bell, Bug, ClipboardPaste, Palette, Settings2, StickyNote, X } from "lucide-react";
import { useDebugLogging } from "../hooks/useDebugLogging";
import { loadCliSafePasteEnabled, saveCliSafePasteEnabled } from "../native/clipboard";
import {
  applyScratchpadShortcutState,
  loadScratchpadShortcutState,
  saveScratchpadShortcutState,
  scratchpadShortcutLabel,
  type ScratchpadShortcutState,
} from "../native/scratchpadShortcut";
import {
  loadWindowsNotificationsEnabled,
  saveWindowsNotificationsEnabled,
  showWindowsNotification,
} from "../native/windowsNotifications";
import { type AmoTheme, useAmoThemeRuntime } from "../theme/amoTheme";
import type { OpenPathResult } from "../types";
import {
  closeUtilityWindow,
  startUtilityWindowDrag,
  useUtilityWindowLifecycle,
} from "./utilityWindow";

export type SettingsSection = "scratchpad" | "clipboard" | "theme" | "notifications" | "debug";

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
        className={`settings-nav-button ${settingsSection === "clipboard" ? "is-active" : ""}`}
        onClick={() => onSettingsSectionChange("clipboard")}
      >
        <ClipboardPaste size={13} aria-hidden="true" />
        <span>Clipboard</span>
      </button>
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
      <button
        type="button"
        className={`settings-nav-button ${settingsSection === "notifications" ? "is-active" : ""}`}
        onClick={() => onSettingsSectionChange("notifications")}
      >
        <Bell size={13} aria-hidden="true" />
        <span>Notifications</span>
      </button>
      <button
        type="button"
        className={`settings-nav-button ${settingsSection === "debug" ? "is-active" : ""}`}
        onClick={() => onSettingsSectionChange("debug")}
      >
        <Bug size={13} aria-hidden="true" />
        <span>Debug</span>
      </button>
    </aside>
  );
}

interface SettingsDetailHeaderProps {
  settingsSection: SettingsSection;
  scratchpadShortcut: ScratchpadShortcutState;
  safePasteEnabled: boolean;
  amoTheme: AmoTheme;
  debugEnabled: boolean;
  debugCount: number;
  windowsNotificationsEnabled: boolean;
}

function SettingsDetailHeader({
  settingsSection,
  scratchpadShortcut,
  safePasteEnabled,
  amoTheme,
  debugEnabled,
  debugCount,
  windowsNotificationsEnabled,
}: SettingsDetailHeaderProps) {
  const title =
    settingsSection === "theme"
      ? "Theme"
      : settingsSection === "clipboard"
        ? "Clipboard"
        : settingsSection === "notifications"
          ? "Notifications"
          : settingsSection === "debug"
            ? "Debug"
            : "Scratchpad";
  const status =
    settingsSection === "theme"
      ? amoTheme === "light"
        ? "Light"
        : "Dark"
      : settingsSection === "clipboard"
        ? safePasteEnabled
          ? "Safe mode"
          : "Original formatting"
        : settingsSection === "notifications"
          ? windowsNotificationsEnabled
            ? "Enabled"
            : "Disabled"
          : settingsSection === "debug"
            ? debugEnabled
              ? `Enabled | ${debugCount} entries`
              : "Disabled"
            : scratchpadShortcutLabel(scratchpadShortcut);

  return (
    <header className="settings-detail-header">
      <div>
        <strong>{title}</strong>
        <span>{status}</span>
      </div>
    </header>
  );
}

interface ClipboardSettingsBodyProps {
  safePasteEnabled: boolean;
  onSafePasteEnabledChange: (enabled: boolean) => void;
}

function ClipboardSettingsBody({ safePasteEnabled, onSafePasteEnabledChange }: ClipboardSettingsBodyProps) {
  return (
    <div className="settings-section-body">
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={safePasteEnabled}
          onChange={(event) => onSafePasteEnabledChange(event.currentTarget.checked)}
        />
        <span>Safe CLI copy</span>
      </label>
      <p className="settings-help-copy">
        Replace copied line breaks with spaces so terminal CLIs cannot submit a partial prompt while pasting.
      </p>
    </div>
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
          value={scratchpadShortcut.shortcut}
          disabled={!scratchpadShortcut.enabled}
          onChange={(event) =>
            onScratchpadShortcutChange({
              ...scratchpadShortcut,
              shortcut: event.currentTarget.value as ScratchpadShortcutState["shortcut"],
            })
          }
        >
          <option value="ctrl+alt+space">Ctrl + Alt + Space</option>
          <option value="ctrl+mouse4">Ctrl + Mouse4</option>
          <option value="mouse4">Mouse4</option>
          <option value="ctrl+mouse5">Ctrl + Mouse5</option>
          <option value="mouse5">Mouse5</option>
        </select>
      </label>

      <p className="settings-help-copy">
        Keyboard shortcuts work without a side-button mouse. Plain Mouse4/Mouse5 are faster but may replace browser navigation.
      </p>

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

interface NotificationSettingsBodyProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onSendTest: () => void;
}

function NotificationSettingsBody({
  enabled,
  onEnabledChange,
  onSendTest,
}: NotificationSettingsBodyProps) {
  return (
    <div className="settings-section-body">
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onEnabledChange(event.currentTarget.checked)}
        />
        <span>Enable Windows notifications</span>
      </label>
      <p className="settings-help-copy">
        Notify once when a task newly needs review, permission, or error handling. Existing attention cards are quiet when AMO starts.
      </p>
      <button
        type="button"
        className="settings-primary-action"
        disabled={!enabled}
        onClick={onSendTest}
      >
        Send test notification
      </button>
    </div>
  );
}

interface DebugSettingsBodyProps {
  debugBusy: boolean;
  debugCount: number;
  debugEnabled: boolean;
  onToggleDebugLogging: () => void;
}

function DebugSettingsBody({
  debugBusy,
  debugCount,
  debugEnabled,
  onToggleDebugLogging,
}: DebugSettingsBodyProps) {
  return (
    <div className="settings-section-body">
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={debugEnabled}
          disabled={debugBusy}
          onChange={onToggleDebugLogging}
        />
        <span>{debugBusy ? "Updating debug logging" : "Enable debug logging"}</span>
      </label>
      <div className="settings-debug-status" aria-live="polite">
        <span>Status</span>
        <strong>{debugEnabled ? `Enabled | ${debugCount} entries` : "Disabled"}</strong>
      </div>
    </div>
  );
}

interface SettingsDetailProps {
  settingsSection: SettingsSection;
  scratchpadShortcut: ScratchpadShortcutState;
  safePasteEnabled: boolean;
  amoTheme: AmoTheme;
  debugBusy: boolean;
  debugCount: number;
  debugEnabled: boolean;
  windowsNotificationsEnabled: boolean;
  onScratchpadShortcutChange: (next: ScratchpadShortcutState) => void;
  onSafePasteEnabledChange: (enabled: boolean) => void;
  onOpenScratchpadNow: () => void;
  onAmoThemeChange: (theme: AmoTheme) => void;
  onToggleDebugLogging: () => void;
  onWindowsNotificationsEnabledChange: (enabled: boolean) => void;
  onSendTestNotification: () => void;
}

export function SettingsDetail({
  settingsSection,
  scratchpadShortcut,
  safePasteEnabled,
  amoTheme,
  debugBusy,
  debugCount,
  debugEnabled,
  windowsNotificationsEnabled,
  onScratchpadShortcutChange,
  onSafePasteEnabledChange,
  onOpenScratchpadNow,
  onAmoThemeChange,
  onToggleDebugLogging,
  onWindowsNotificationsEnabledChange,
  onSendTestNotification,
}: SettingsDetailProps) {
  return (
    <div className="settings-detail">
      <SettingsDetailHeader
        settingsSection={settingsSection}
        scratchpadShortcut={scratchpadShortcut}
        safePasteEnabled={safePasteEnabled}
        amoTheme={amoTheme}
        debugEnabled={debugEnabled}
        debugCount={debugCount}
        windowsNotificationsEnabled={windowsNotificationsEnabled}
      />

      {settingsSection === "scratchpad" ? (
        <ScratchpadSettingsBody
          scratchpadShortcut={scratchpadShortcut}
          onScratchpadShortcutChange={onScratchpadShortcutChange}
          onOpenScratchpadNow={onOpenScratchpadNow}
        />
      ) : settingsSection === "clipboard" ? (
        <ClipboardSettingsBody
          safePasteEnabled={safePasteEnabled}
          onSafePasteEnabledChange={onSafePasteEnabledChange}
        />
      ) : settingsSection === "theme" ? (
        <ThemeSettingsBody amoTheme={amoTheme} onAmoThemeChange={onAmoThemeChange} />
      ) : settingsSection === "notifications" ? (
        <NotificationSettingsBody
          enabled={windowsNotificationsEnabled}
          onEnabledChange={onWindowsNotificationsEnabledChange}
          onSendTest={onSendTestNotification}
        />
      ) : (
        <DebugSettingsBody
          debugBusy={debugBusy}
          debugCount={debugCount}
          debugEnabled={debugEnabled}
          onToggleDebugLogging={onToggleDebugLogging}
        />
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
  const [safePasteEnabled, setSafePasteEnabled] = useState(() => loadCliSafePasteEnabled());
  const [windowsNotificationsEnabled, setWindowsNotificationsEnabled] = useState(() =>
    loadWindowsNotificationsEnabled(),
  );
  const [feedback, setFeedback] = useState("Settings ready.");
  const {
    attachFeedbackSetter,
    debugBusy,
    debugCount,
    debugEnabled,
    refreshDebugStatus,
    toggleDebugLogging,
  } = useDebugLogging();
  attachFeedbackSetter(setFeedback);

  useEffect(() => {
    void refreshDebugStatus();
  }, []);

  async function updateScratchpadShortcut(next: ScratchpadShortcutState) {
    try {
      const result = await applyScratchpadShortcutState(next);
      if (!result.ok) {
        setFeedback(result.message);
        return;
      }
      setScratchpadShortcut(next);
      saveScratchpadShortcutState(next);
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

  function updateSafePasteEnabled(enabled: boolean) {
    setSafePasteEnabled(enabled);
    saveCliSafePasteEnabled(enabled);
    setFeedback(enabled ? "Safe CLI copy enabled." : "Original clipboard formatting enabled.");
  }

  async function updateWindowsNotificationsEnabled(enabled: boolean) {
    setWindowsNotificationsEnabled(enabled);
    await saveWindowsNotificationsEnabled(enabled);
    setFeedback(enabled ? "Windows notifications enabled." : "Windows notifications disabled.");
  }

  async function sendTestNotification() {
    const result = await showWindowsNotification(
      "AMO: Test notification",
      "Windows notifications are ready. New attention events will appear here.",
    );
    setFeedback(result.message);
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
          safePasteEnabled={safePasteEnabled}
          amoTheme={amoTheme}
          debugBusy={debugBusy}
          debugCount={debugCount}
          debugEnabled={debugEnabled}
          windowsNotificationsEnabled={windowsNotificationsEnabled}
          onScratchpadShortcutChange={(next) => void updateScratchpadShortcut(next)}
          onSafePasteEnabledChange={updateSafePasteEnabled}
          onOpenScratchpadNow={() => void openScratchpadNow()}
          onAmoThemeChange={(next) => void updateAmoTheme(next)}
          onToggleDebugLogging={() => void toggleDebugLogging()}
          onWindowsNotificationsEnabledChange={(enabled) => void updateWindowsNotificationsEnabled(enabled)}
          onSendTestNotification={() => void sendTestNotification()}
        />

        <footer className="app-dialog-footer">
          <span title={feedback}>{feedback}</span>
        </footer>
      </section>
    </main>
  );
}
