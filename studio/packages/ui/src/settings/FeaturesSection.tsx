import { useEffect, useState } from "react";
import { OPTIONAL_FEATURES, type OptionalFeature } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

// 设置 → 功能: optional features on or off. Off hides their pages and panels in both windows and their tools from the
// agents (sessions started from then on); their data stays and comes back when the feature is turned on again.

export function FeaturesSection({ link, disabled, teamAutoSend }: { link: HostLink; disabled: readonly OptionalFeature[]; teamAutoSend: boolean }) {
  // Shown at once; the Host's settings event confirms it (or the error puts it back).
  const [shown, setShown] = useState<readonly OptionalFeature[]>(disabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = disabled.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the list by content
  useEffect(() => setShown(disabled), [key]);

  async function toggle(id: OptionalFeature, on: boolean) {
    const next = on ? shown.filter((x) => x !== id) : [...shown, id];
    setShown(next);
    setBusy(true);
    setError(null);
    try {
      await call(link, "PUT /api/settings", {}, { disabledFeatures: next });
    } catch (err) {
      setShown(disabled);
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <section className="settings-section" aria-label="功能">
      <span className="settings-heading">功能</span>
      <span className="settings-hint">不常用的功能可以关掉：页面和入口会隐藏，agent 也看不到它们的工具（之后新开的会话）。数据都保留，再打开就回来。</span>
      {OPTIONAL_FEATURES.map((f) => {
        const on = !shown.includes(f.id);
        return (
          <label key={f.id} className="settings-row feature-row">
            <input type="checkbox" checked={on} disabled={busy} onChange={(e) => void toggle(f.id, e.target.checked)} data-testid={`feature-${f.id}`} />
            <span className="feature-text">
              <span className="settings-label">{f.label}</span>
              <span className="settings-hint">{f.hint}</span>
            </span>
          </label>
        );
      })}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </section>
    <TeamAutoSend link={link} on={teamAutoSend} />
    </>
  );
}

/**
 * 中转 (2026-10-30, the user: 需要审批的发送可以加一个设置，开启后不用审批自动发送): what a session asks someone on
 * the team goes at once instead of waiting for 发送. Off by default — it goes to a real person, as the person.
 */
function TeamAutoSend({ link, on }: { link: HostLink; on: boolean }) {
  const [shown, setShown] = useState(on);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setShown(on), [on]);

  async function toggle(next: boolean) {
    setShown(next);
    setBusy(true);
    setError(null);
    try {
      await call(link, "PUT /api/settings", {}, { teamAutoSend: next });
    } catch (err) {
      setShown(on);
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-label="中转">
      <span className="settings-heading">中转</span>
      <label className="settings-row feature-row">
        <input type="checkbox" checked={shown} disabled={busy} onChange={(e) => void toggle(e.target.checked)} data-testid="team-auto-send" />
        <span className="feature-text">
          <span className="settings-label">AI 找人确认时直接发出，不用先问我</span>
          <span className="settings-hint">会话通过 AMO 中转找团队里的人确认、追问时，不再等你点「发送」。发出去照样用你的账号、标着「AI 代发」，看板卡片上照样显示在等谁。对方是真人，开之前想清楚；默认关着，每次都先问你。</span>
        </span>
      </label>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </section>
  );
}
