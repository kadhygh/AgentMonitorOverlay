import { useEffect, useRef, useState } from "react";
import { Avatar, timeText, Who } from "./bits.js";
import { Check, Dialog, Field, Pick } from "./Dialog.js";
import { copyText, shell } from "./env.js";
import { errorText } from "./Messages.js";
import { useSession, type Session } from "./session.js";
import type { McpHookup, RelayFile } from "./shared.js";
import { FONT_LABEL, FONT_SIZES, readFontSize, readTheme, setFontSize, setTheme, THEME_LABEL, type FontSize, type Theme } from "./theme.js";

// 设置 (the layout redesign, 2026-10-27): one dialog with its parts on the left — 通用 (this computer's: font size,
// theme), 团队流程 (the team's: the flow document on the service, whether it runs its scripts, 流程速查's phrases, when
// an AI counts as slow), 接入 AI (MCP), 我的资料. Only 团队流程 is saved with a button; the rest apply at once.

export type SettingsPart = "general" | "flow" | "ai" | "profile";
const PARTS: Array<[SettingsPart, string]> = [
  ["general", "通用"],
  ["flow", "团队流程"],
  ["ai", "接入 AI"],
  ["profile", "我的资料"],
];

export function SettingsDialog(props: { session: Session; part?: SettingsPart; onClose: () => void; toast: (t: string) => void; onCopyUsage: () => void; onProfile: () => void; onLogout: () => void; onOpenFile: (id: string) => void }) {
  const [part, setPart] = useState<SettingsPart>(props.part ?? "general");
  const flow = useFlowForm(props.session, props.onClose, props.toast);
  return (
    <Dialog
      title="设置"
      className="settings-dialog"
      bare
      onClose={props.onClose}
      foot={
        part === "flow" ? (
          <>
            <span className="foot-note">这一页是团队设置，保存后全队都用新的</span>
            <button type="button" onClick={props.onClose}>
              取消
            </button>
            <button type="button" className="primary" disabled={flow.busy} onClick={() => void flow.save()}>
              保存
            </button>
          </>
        ) : undefined
      }
    >
      <div className="settings-body">
        <nav className="settings-nav" aria-label="设置分类">
          {PARTS.map(([p, label]) => (
            <button key={p} type="button" aria-current={part === p ? "page" : undefined} onClick={() => setPart(p)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-pane">
          {part === "general" && <GeneralPart />}
          {part === "flow" && <FlowPart session={props.session} form={flow} toast={props.toast} onOpenFile={props.onOpenFile} />}
          {part === "ai" && <AiPart onCopyUsage={props.onCopyUsage} toast={props.toast} />}
          {part === "profile" && <ProfilePart session={props.session} onProfile={props.onProfile} onLogout={props.onLogout} />}
        </div>
      </div>
    </Dialog>
  );
}

function Part({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="set-part">
      <div className="set-head">
        <b>{title}</b>
        {hint && <span className="field-hint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function GeneralPart() {
  const [px, setPx] = useState<FontSize>(readFontSize);
  const [theme, setThemeState] = useState<Theme>(readTheme);
  return (
    <>
      <Part title="字体大小" hint="只影响这台电脑；界面里的文字一起变">
        <div className="font-pick" role="radiogroup" aria-label="字体大小">
          {FONT_SIZES.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={s === px} className={s === px ? "on" : ""} onClick={() => (setFontSize(s), setPx(s))}>
              <span style={{ fontSize: s }}>{FONT_LABEL[s]}</span>
              <span className="muted tiny">{s} px</span>
            </button>
          ))}
        </div>
        <div className="font-preview">
          <b>技能冷却怎么算</b>
          <span className="dim">策划小王的 AI 发来 · 等你回复 3 个问题</span>
          <span className="muted tiny">预览</span>
        </div>
      </Part>
      <Part title="主题">
        <Pick<Theme>
          label="主题"
          value={theme}
          onChange={(t) => (setTheme(t), setThemeState(t))}
          options={(["system", "light", "dark"] as const).map((t) => ({ value: t, label: THEME_LABEL[t] }))}
        />
      </Part>
    </>
  );
}

function useFlowForm(session: Session, onClose: () => void, toast: (t: string) => void) {
  const { settings } = useSession(session);
  const [flow, setFlow] = useState(settings.flow);
  const [scripts, setScripts] = useState(settings.flowScripts !== false);
  const [keywords, setKeywords] = useState(settings.keywords);
  const [late, setLate] = useState(String(settings.aiLateMinutes));
  const [stuck, setStuck] = useState(String(settings.aiStuckMinutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await session.client.saveSettings({ flow, flowScripts: scripts, keywords, aiLateMinutes: Number(late), aiStuckMinutes: Number(stuck) });
      onClose();
      toast("设置已保存，全队都会用新的");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return { flow, setFlow, scripts, setScripts, keywords, setKeywords, late, setLate, stuck, setStuck, busy, error, save };
}

function FlowPart({ session, form, toast, onOpenFile }: { session: Session; form: ReturnType<typeof useFlowForm>; toast: (t: string) => void; onOpenFile: (id: string) => void }) {
  const doc = useSession(session).settings.flowDoc ?? null;
  const [versions, setVersions] = useState<RelayFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [word, setWord] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!doc) return setVersions([]);
    session.client
      .versions(doc.id)
      .then(setVersions)
      .catch(() => setVersions([]));
  }, [session, doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const f = await session.client.upload({ slot: "flow" }, file.name, file, file.type || (/\.md$/i.test(file.name) ? "text/markdown" : "text/html"));
      toast(`已换成第 ${f.version} 版，大家左下的「团队流程」会提示有更新`);
    } catch (err) {
      toast(errorText(err));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  };
  const addWord = () => {
    const w = word.trim();
    if (w && !form.keywords.includes(w)) form.setKeywords([...form.keywords, w]);
    setWord("");
  };

  return (
    <>
      <Part title="流程文档" hint="放在服务器上，全队打开的是同一份；左下「团队流程」打开的就是它">
        <div className="flow-card">
          <span className="file-ico">{doc ? doc.name.split(".").pop()?.slice(0, 4) : "html"}</span>
          <span className="grow flow-card-text">
            {doc ? (
              <>
                <b className="ellipsis">{doc.name}</b>
                <span className="muted tiny">
                  第 {doc.version} 版 · {doc.by} {timeText(doc.at)} 更新
                </span>
              </>
            ) : (
              <>
                <b>还没有上传</b>
                <span className="muted tiny">上传一份 HTML 或 Markdown，之后谁改了谁传新版本</span>
              </>
            )}
          </span>
          {doc && (
            <button type="button" onClick={() => onOpenFile(doc.id)}>
              打开
            </button>
          )}
          <button type="button" className="primary" disabled={uploading} onClick={() => input.current?.click()}>
            {uploading ? "上传中…" : doc ? "上传新版本…" : "上传…"}
          </button>
          <input ref={input} type="file" accept=".html,.htm,.md,.markdown" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        </div>
        {versions.length > 1 && (
          <div className="flow-log">
            <span className="flow-log-head">更新记录</span>
            {versions.slice(0, 4).map((v) => (
              <span key={v.id}>
                第 {v.version} 版 · {v.by} · {timeText(v.at)}
              </span>
            ))}
            {versions.length > 4 && <span className="muted">更早的在文档的版本里能切换</span>}
          </div>
        )}
        <Check checked={form.scripts} onChange={form.setScripts}>
          允许这份文档运行自己的脚本（里面的「复制提示词」按钮要用；别的文件仍然不运行）
        </Check>
      </Part>
      <Part title="流程速查" hint="点一下就复制的说法">
        <div className="kw-chips">
          {form.keywords.map((k) => (
            <span key={k} className="kw-chip">
              {k}
              <button type="button" className="x small-x" title="去掉" onClick={() => form.setKeywords(form.keywords.filter((x) => x !== k))}>
                ×
              </button>
            </span>
          ))}
          <input className="kw-add" value={word} onChange={(e) => setWord(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addWord())} onBlur={addWord} placeholder="＋ 加一条，回车" />
        </div>
      </Part>
      <Part title="写给 AI 的流程" hint="文字版，放进复制用法和任务提示词">
        <textarea value={form.flow} onChange={(e) => form.setFlow(e.target.value)} rows={5} />
      </Part>
      <Part title="AI 提醒">
        <div className="ai-limits">
          <label>
            AI 超过 <input type="number" min={1} max={1440} value={form.late} onChange={(e) => form.setLate(e.target.value)} aria-label="还没取回的分钟数" /> 分钟没取回，标「还没取回」
          </label>
          <label>
            取回后超过 <input type="number" min={1} max={1440} value={form.stuck} onChange={(e) => form.setStuck(e.target.value)} aria-label="卡住的分钟数" /> 分钟没动作，标「卡住」
          </label>
        </div>
      </Part>
      {form.error && <div className="notice error">{form.error}</div>}
    </>
  );
}

const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

function AiPart({ onCopyUsage, toast }: { onCopyUsage: () => void; toast: (t: string) => void }) {
  const [hookup, setHookup] = useState<McpHookup | null>(null);
  useEffect(() => void shell?.mcp().then(setHookup), []);
  const usage = (
    <Part title="复制用法（推荐）" hint="平时不占 AI 的上下文">
      <p className="lead-p dim small">把本机用法文档的位置贴给 agent，它会自己去读，用命令行收发会话。左下也有「复制用法」。</p>
      <div>
        <button type="button" onClick={onCopyUsage}>
          复制用法
        </button>
      </div>
    </Part>
  );
  if (!shell)
    return (
      <>
        {usage}
        <Part title="MCP">
          <p className="lead-p dim small">浏览器里没法让本机的 AI 直接接入。要用 MCP，请下载桌面客户端（服务器首页有下载）。</p>
        </Part>
      </>
    );
  if (!hookup) return usage;
  const envFlags = Object.entries(hookup.env)
    .map(([k, v]) => `-e ${k}=${v}`)
    .join(" ");
  const claude = `claude mcp add amo-relay --scope user ${envFlags} -- ${[hookup.command, ...hookup.args].map(quote).join(" ")}`;
  const toml = [
    "[mcp_servers.amo-relay]",
    `command = ${JSON.stringify(hookup.command)}`,
    `args = [${hookup.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    `env = { ${Object.entries(hookup.env)
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join(", ")} }`,
  ].join("\n");
  const json = JSON.stringify({ mcpServers: { "amo-relay": { command: hookup.command, args: hookup.args, env: hookup.env } } }, null, 2);
  const block = (label: string, text: string, hint: string) => (
    <div className="hookup">
      <div className="hookup-head">
        <b>{label}</b>
        <span className="muted tiny">{hint}</span>
        <div className="grow" />
        <button type="button" className="small" onClick={() => void copyText(text).then(() => toast(`已复制 ${label} 的配置`))}>
          复制
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
  return (
    <>
      {usage}
      <Part title="接入 MCP" hint="接了以后每个对话都带上中转的工具（约 6 千字符的上下文）">
        {block("Claude Code", claude, "在终端里运行一次")}
        {block("Codex", toml, "加到 ~/.codex/config.toml")}
        {block("其他客户端", json, "支持 mcpServers JSON 的都可以")}
        <p className="lead-p muted tiny">
          不支持 MCP 的 agent 用复制用法，里面带着命令行 <code>{hookup.cli}</code>
        </p>
      </Part>
    </>
  );
}

function ProfilePart({ session, onProfile, onLogout }: { session: Session; onProfile: () => void; onLogout: () => void }) {
  const me = session.me.name;
  const role = useSession(session).members.find((m) => m.name === me)?.role ?? session.me.role;
  return (
    <>
      <Part title="我的资料" hint="昵称、头像、负责什么，团队里的人都看得到">
        <div className="me-card">
          <Avatar name={me} big />
          <span className="grow me-card-text">
            <b>
              <Who name={me} />
            </b>
            <span className="dim small">{role || "（没写负责什么）"}</span>
          </span>
          <button type="button" onClick={onProfile}>
            编辑资料
          </button>
        </div>
      </Part>
      <Part title="账号">
        <div className="dim small">
          服务器 <code>{session.me.server}</code> · 团队「{session.me.service}」
        </div>
        <div>
          <button type="button" onClick={onLogout}>
            退出登录
          </button>
        </div>
      </Part>
    </>
  );
}
