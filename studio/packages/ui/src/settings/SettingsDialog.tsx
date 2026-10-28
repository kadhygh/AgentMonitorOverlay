import { useEffect, useState } from "react";
import { projectWorkspaces, type ModelProfile, type StudioSettings, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent } from "../host/events.js";
import { setThemePref, THEME_LABELS, themePref, type ThemePref } from "../lib/theme.js";
import { ModelsPage } from "./ModelsPage.js";
import { SubsessionPage } from "./SubsessionPage.js";
import { FeaturesSection } from "./FeaturesSection.js";
import { ScratchpadSettings } from "../scratchpad/ScratchpadSettings.js";
import { DataPage } from "./DataPage.js";
import { QuotaPage } from "./QuotaPage.js";
import { StatsPage } from "./StatsPage.js";
import { useDialogSize } from "./dialogSize.js";
import { MaintenancePage } from "./MaintenancePage.js";
import { RemotePage } from "./RemotePage.js";
import { remoteWaiting, useRemote } from "./remote.js";
import { FolderAccessSection } from "./FolderAccessSection.js";
import { setScrollOnSend, setTranscriptView, TRANSCRIPT_VIEW_HINTS, TRANSCRIPT_VIEW_LABELS, useScrollOnSend, useTranscriptView, type TranscriptView } from "../chat/prefs.js";
import { useChatSettings } from "../chat/cli/chatSettings.js";
import { defaultFolder, setDefaultFolder } from "../lib/profiles.js";
import { BotArt, MascotArt, ReaderArt } from "../focus/PixelBot.js";
import { PET_SKINS, usePetSkin, writePetSkin, type PetSkin } from "../focus/petSkin.js";
import { pickDirectory } from "../folders/FolderPicker.js";

/** Studio-wide settings from the Host, kept live. */
export function useSettings(link: HostLink): StudioSettings | null {
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  useEffect(() => {
    let cancelled = false;
    call(link, "GET /api/settings")
      .then((s) => !cancelled && setSettings(s))
      .catch(() => undefined);
    const off = onHostEvent((e) => {
      if (e.type === "settings.updated") setSettings(e.settings);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [link]);
  return settings;
}

/** The pages of 设置, one per area, in the left column. */
const PAGES = [
  { id: "ui", label: "界面" },
  { id: "models", label: "模型" },
  { id: "subsession", label: "子会话" },
  { id: "quota", label: "额度" },
  { id: "stats", label: "统计" },
  { id: "common", label: "项目与目录" },
  { id: "features", label: "功能" },
  { id: "scratchpad", label: "便签" },
  { id: "data", label: "数据管理" },
  { id: "remote", label: "远程" },
  { id: "maintenance", label: "维护" },
] as const;
export type SettingsPage = (typeof PAGES)[number]["id"];

// The page last open, for the next time 设置 opens in this window.
let lastPage: SettingsPage = "ui";

/**
 * 设置, in pages: 界面 (the look, per install), 模型 (how Claude signs in, keys, 常用预设), 项目与目录 (the default project of
 * new tasks, and the common folder for sessions that belong to no single project: the scheduler's rounds, and the default
 * for cross-workspace sessions), 功能 and 便签.
 */
export function SettingsDialog({ link, settings, workspaces = [], tasks = [], topics = [], profiles = [], page: startPage, onClose }: { link: HostLink; settings: StudioSettings | null; workspaces?: readonly Workspace[]; /** 远程: the tasks granted to other devices, and the models they may use. */ tasks?: readonly Task[]; /** 远程 step 4: where an allowed request's task may go. */ topics?: readonly Topic[]; profiles?: readonly ModelProfile[]; /** Opens on this page (Focus's 「在设置里看」). */ page?: SettingsPage; onClose(): void }) {
  const [page, setPage] = useState<SettingsPage>(startPage ?? lastPage);
  const remoteWaits = remoteWaiting(useRemote(link)) > 0;
  const [theme, setTheme] = useState<ThemePref>(themePref);
  const view = useTranscriptView();
  const jumpOnSend = useScrollOnSend();
  const chat = useChatSettings(link);
  const [dir, setDir] = useState(settings?.commonWorkspace?.path ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const size = useDialogSize();

  useEffect(() => setDir(settings?.commonWorkspace?.path ?? ""), [settings?.commonWorkspace?.path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function saveCommon(value: string) {
    setBusy(true);
    setMessage(null);
    try {
      const next = await call(link, "PUT /api/settings", {}, { commonDir: value });
      setMessage({ text: `公共目录：${next.commonWorkspace.path}` });
    } catch (err) {
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  async function pick() {
    const chosen = await pickDirectory();
    if (chosen) setDir(chosen);
  }

  function open(next: SettingsPage) {
    lastPage = next;
    setPage(next);
    setMessage(null);
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal" role="dialog" aria-modal="true" aria-label="设置" style={size.style}>
        <div className="modal-head">
          <span className="modal-title">设置</span>
          <span className="spacer" />
          <button type="button" className="link-btn" onClick={onClose} aria-label="关闭设置">
            关闭
          </button>
        </div>
        <div className="settings-body">
          <div className="settings-nav" role="tablist" aria-label="设置分类" aria-orientation="vertical">
            {PAGES.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                id={`settings-tab-${p.id}`}
                aria-selected={page === p.id}
                aria-controls="settings-page"
                className="settings-tab"
                onClick={() => open(p.id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  const i = PAGES.findIndex((x) => x.id === page);
                  const next = PAGES[(i + (e.key === "ArrowDown" ? 1 : PAGES.length - 1)) % PAGES.length]!.id;
                  open(next);
                  document.getElementById(`settings-tab-${next}`)?.focus();
                }}
              >
                {p.label}
                {p.id === "remote" && remoteWaits && <span className="settings-dot" aria-label="有请求或回复" title="有配对请求、任务请求或对方的回复等你看" data-testid="settings-remote-dot" />}
              </button>
            ))}
          </div>
          <div className="settings-page" id="settings-page" role="tabpanel" aria-labelledby={`settings-tab-${page}`} key={page}>
            {page === "ui" && (
              <section className="settings-section" aria-label="界面">
                <span className="settings-heading">界面</span>
                <div className="settings-row">
                  <span className="settings-label">主题</span>
                  <div role="radiogroup" aria-label="主题" className="chips">
                    {(Object.keys(THEME_LABELS) as ThemePref[]).map((p) => (
                      <button
                        key={p}
                        type="button"
                        role="radio"
                        className="chip"
                        aria-checked={theme === p}
                        aria-pressed={theme === p}
                        onClick={() => {
                          setTheme(p);
                          setThemePref(p);
                        }}
                      >
                        {THEME_LABELS[p]}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="settings-hint">只影响这台电脑上的 Studio；Focus 悬浮窗会一起切换。</span>
                <PetSkinRow />
                {window.amo?.uiScale && <UiScaleRow />}
                <div className="settings-row">
                  <span className="settings-label">工作步骤展示</span>
                  <div role="radiogroup" aria-label="工作步骤展示" className="chips">
                    {(Object.keys(TRANSCRIPT_VIEW_LABELS) as TranscriptView[]).map((v) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        className="chip"
                        aria-checked={view === v}
                        aria-pressed={view === v}
                        title={TRANSCRIPT_VIEW_HINTS[v]}
                        onClick={() => setTranscriptView(v)}
                      >
                        {TRANSCRIPT_VIEW_LABELS[v]}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="settings-hint">{TRANSCRIPT_VIEW_HINTS[view]}。</span>
                <div className="settings-row">
                  <span className="settings-label">发送后跳到最新</span>
                  <div role="radiogroup" aria-label="发送后跳到最新" className="chips">
                    {([true, false] as const).map((on) => (
                      <button
                        key={String(on)}
                        type="button"
                        role="radio"
                        className="chip"
                        aria-checked={jumpOnSend === on}
                        aria-pressed={jumpOnSend === on}
                        onClick={() => setScrollOnSend(on)}
                        data-testid={`scroll-on-send-${on ? "on" : "off"}`}
                      >
                        {on ? "开启" : "关闭"}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="settings-hint">在输入框发出消息后，对话直接跳到最末尾并跟着回复往下走，不管之前看到哪里。关闭后停在原来看的位置。</span>
                <div className="settings-row">
                  <span className="settings-label">建议的下一句</span>
                  <div role="radiogroup" aria-label="建议的下一句" className="chips">
                    {([true, false] as const).map((on) => (
                      <button
                        key={String(on)}
                        type="button"
                        role="radio"
                        className="chip"
                        aria-checked={chat.settings.promptSuggestions === on}
                        aria-pressed={chat.settings.promptSuggestions === on}
                        onClick={() => void chat.update({ promptSuggestions: on }).catch((err: unknown) => setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true }))}
                      >
                        {on ? "显示" : "关闭"}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="settings-hint">Claude 会话每轮回答后，在输入框上方给出建议的下一句，点一下填进输入框。默认关闭：每轮会多一次很小的模型请求。</span>
                {message && (
                  <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"} data-testid="settings-message">
                    {message.text}
                  </span>
                )}
              </section>
            )}

            {page === "models" && <ModelsPage link={link} settings={settings} />}
            {page === "subsession" && <SubsessionPage link={link} settings={settings} />}
            {page === "quota" && <QuotaPage link={link} settings={settings} />}
            {page === "stats" && <StatsPage link={link} />}

            {page === "common" && <DefaultFolderSection />}
            {page === "common" && (
              <section className="settings-section" aria-label="公共目录">
                <span className="settings-heading">公共目录</span>
                <span className="settings-hint">没有指定项目的任务、调度 agent，以及没选项目的专题会话都在这个文件夹里运行。默认是数据目录下的 common 文件夹。</span>
                <div className="settings-row">
                  <input className="field" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="例如 D:\AMO\common" aria-label="公共目录" />
                  {window.amo?.pickDirectory && (
                    <button type="button" className="btn-ghost small" onClick={() => void pick()} disabled={busy}>
                      选择…
                    </button>
                  )}
                </div>
                <div className="settings-row end">
                  <button type="button" className="btn-primary small" onClick={() => void saveCommon(dir.trim())} disabled={busy || !dir.trim() || dir.trim() === settings?.commonWorkspace?.path}>
                    保存
                  </button>
                </div>
                {message && (
                  <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"} data-testid="settings-message">
                    {message.text}
                  </span>
                )}
              </section>
            )}
            {page === "common" && <FolderAccessSection link={link} />}
            {page === "features" && <FeaturesSection link={link} disabled={settings?.disabledFeatures ?? []} />}
            {page === "scratchpad" && <ScratchpadSettings link={link} settings={settings} />}
            {page === "data" && <DataPage link={link} />}
            {page === "remote" && <RemotePage link={link} tasks={tasks} profiles={profiles} workspaces={workspaces} topics={topics} />}
            {page === "maintenance" && <MaintenancePage link={link} />}
          </div>
        </div>
        <span className="settings-grip" role="separator" aria-label="拖动改变设置窗口大小，双击恢复默认" title="拖动改变大小，双击恢复默认" data-testid="settings-grip" {...size.grip} />
      </div>
    </div>
  );
}

/** 默认路径 (2026-10-17, in place of 默认项目): where 选择文件夹 starts when adding a project; kept on this machine. */
function DefaultFolderSection() {
  const [path, setPath] = useState(defaultFolder);
  const [saved, setSaved] = useState(defaultFolder);
  const save = (next: string) => {
    setDefaultFolder(next);
    setPath(next.trim());
    setSaved(next.trim());
  };
  const browse = async () => {
    const chosen = await pickDirectory(path.trim() || null);
    if (chosen) save(chosen);
  };
  return (
    <section className="settings-section" aria-label="默认路径">
      <span className="settings-heading">默认路径</span>
      <span className="settings-hint">添加项目时点「选择文件夹」，从这个文件夹开始选（比如放所有工程的目录）。不填就从系统默认的位置开始。只存在这台电脑上。</span>
      <div className="settings-row">
        <input className="field" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save(path)} placeholder="例如 G:\PROJECT" aria-label="默认路径" />
        {window.amo?.pickDirectory && (
          <button type="button" className="btn-ghost small" onClick={() => void browse()}>
            选择…
          </button>
        )}
      </div>
      <div className="settings-row end">
        {saved && (
          <button type="button" className="btn-ghost small" onClick={() => save("")}>
            清除
          </button>
        )}
        <button type="button" className="btn-primary small" onClick={() => save(path)} disabled={path.trim() === saved}>
          保存
        </button>
      </div>
    </section>
  );
}

const UI_SCALE_LABELS: Array<[number, string]> = [
  [0.9, "小"],
  [1, "标准"],
  [1.1, "大"],
  [1.25, "较大"],
  [1.4, "特大"],
];

/** 界面大小 (2026-10-15): text and icons of every Studio window, Focus too, together. */
function UiScaleRow() {
  const [scale, setScale] = useState<number | null>(null);
  useEffect(() => {
    const api = window.amo?.uiScale;
    if (!api) return;
    void api.get().then(setScale);
    return api.onChange(setScale);
  }, []);
  return (
    <>
      <div className="settings-row">
        <span className="settings-label">界面大小</span>
        <div role="radiogroup" aria-label="界面大小" className="chips">
          {UI_SCALE_LABELS.map(([s, label]) => (
            <button
              key={s}
              type="button"
              role="radio"
              className="chip"
              aria-checked={scale !== null && Math.abs(scale - s) < 0.001}
              aria-pressed={scale !== null && Math.abs(scale - s) < 0.001}
              onClick={() => {
                setScale(s);
                void window.amo?.uiScale?.set(s);
              }}
            >
              {label} {Math.round(s * 100)}%
            </button>
          ))}
        </div>
      </div>
      <span className="settings-hint">文字和图标一起放大缩小，所有 Studio 窗口（含 Focus）一起变。快捷键：Ctrl + = 放大，Ctrl + - 缩小，Ctrl + 0 恢复标准。</span>
    </>
  );
}

/** Focus 桌宠 (2026-10-15 evening): who pops up on Focus when something needs the person, and flies about when ignored. */
function PetSkinRow() {
  const skin = usePetSkin();
  return (
    <>
      <div className="settings-row">
        <span className="settings-label">Focus 桌宠</span>
        <div role="radiogroup" aria-label="Focus 桌宠" className="chips">
          {(Object.keys(PET_SKINS) as PetSkin[]).map((k) => (
            <button key={k} type="button" role="radio" className="chip" aria-checked={skin === k} aria-pressed={skin === k} onClick={() => writePetSkin(k)} data-testid={`pet-skin-${k}`}>
              {PET_SKINS[k]}
            </button>
          ))}
        </div>
        <span className="settings-pet-preview" data-testid="pet-skin-preview">
          {skin === "reader" ? <ReaderArt mood="calm" /> : skin === "mascot" ? <MascotArt mood="calm" /> : <BotArt mood="calm" />}
        </span>
      </div>
      <span className="settings-hint">有事时在 Focus 上冒出来提醒你；放着 5 分钟不管会生气、满屏乱飞。只影响这台电脑。</span>
      {skin === "mascot" && (
        <span className="settings-hint" data-testid="pet-skin-mascot-hint">
          选了 AMO 娘，左上角和窗口（标题栏、任务栏）的图标也换成她，并跟着换表情：出错或等你审批是「待命」，没额度是「睿智」，有会话在跑是「认真」，只剩等你审核是「开心」，什么都没有是她的头像。
        </span>
      )}
    </>
  );
}
