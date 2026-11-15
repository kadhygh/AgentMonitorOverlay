import { useEffect, useState } from "react";
import { EXPERIMENTAL_FEATURES, type ExperimentalFeature } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

// 设置 → 测试功能 (2026-11-01, the user: 设置里加个测试功能页，这个功能加个开关): features still being tried out, each
// off until turned on. Kept by the Host like 功能, so both windows follow the settings event; but the list here is the
// ones turned on (功能's is the ones turned off).
//
// 2026-11-15 (the user: 给脉络单独加一个弹窗或者选项卡，可以点开时候具体进行设置调整。我们开发中的有些东西可以先放在里面):
// a feature with options of its own (EXPERIMENTAL_FEATURES rows whose `parent` it is) has 「详细设置」 on its row, which
// turns this page into that feature's: what it has now, and the pieces in development to try one by one. An option
// counts only while its feature is on.

type Row = (typeof EXPERIMENTAL_FEATURES)[number];

export function ExperimentalSection({ link, on }: { link: HostLink; on: readonly ExperimentalFeature[] }) {
  // Shown at once; the Host's settings event confirms it (or the error puts it back).
  const [shown, setShown] = useState<readonly ExperimentalFeature[]>(on);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The feature whose own page is open; null: the list. */
  const [detail, setDetail] = useState<ExperimentalFeature | null>(null);
  const key = on.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the list by content
  useEffect(() => setShown(on), [key]);

  async function toggle(id: ExperimentalFeature, next: boolean) {
    const list = next ? [...shown.filter((x) => x !== id), id] : shown.filter((x) => x !== id);
    setShown(list);
    setBusy(true);
    setError(null);
    try {
      await call(link, "PUT /api/settings", {}, { experimentalFeatures: list });
    } catch (err) {
      setShown(on);
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const stage = (f: Row) =>
    f.stage === "dev" && (
      <span className="settings-tag feature-stage" data-testid={`experimental-${f.id}-stage`}>
        开发中
      </span>
    );
  const check = (f: Row, off = false) => (
    <label className={off ? "settings-row feature-row off" : "settings-row feature-row"}>
      <input type="checkbox" checked={shown.includes(f.id)} disabled={busy || off} onChange={(e) => void toggle(f.id, e.target.checked)} data-testid={`experimental-${f.id}`} />
      <span className="feature-text">
        <span className="settings-label">
          {f.label}
          {stage(f)}
        </span>
        <span className="settings-hint">{f.hint}</span>
      </span>
    </label>
  );
  const failed = error && (
    <span className="form-error" role="alert">
      {error}
    </span>
  );

  const feature = detail ? EXPERIMENTAL_FEATURES.find((f) => f.id === detail) : undefined;
  if (feature) {
    const options = EXPERIMENTAL_FEATURES.filter((f) => f.parent === feature.id);
    const off = !shown.includes(feature.id);
    return (
      <section className="settings-section" aria-label={`${feature.label}的设置`} data-testid="experimental-detail">
        <div className="settings-row feature-detail-head">
          <button type="button" className="btn-ghost small" onClick={() => setDetail(null)} data-testid="experimental-back">
            ‹ 测试功能
          </button>
          <span className="settings-heading">{feature.label}</span>
        </div>
        {check(feature)}
        {feature.has && feature.has.length > 0 && (
          <>
            <span className="settings-label feature-group">已经有的（打开「{feature.label}」就有）</span>
            <ul className="feature-has">
              {feature.has.map((h) => (
                <li key={h.label}>
                  <b>{h.label}</b>
                  <span className="settings-hint">{h.hint}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <span className="settings-label feature-group">开发中的，可以单独打开试</span>
        {off && options.length > 0 && <span className="settings-hint">「{feature.label}」关着，下面这些都不生效；先打开上面的总开关。</span>}
        {options.length ? options.map((f) => <div key={f.id}>{check(f, off)}</div>) : <span className="settings-hint">现在没有。</span>}
        {failed}
      </section>
    );
  }

  return (
    <section className="settings-section" aria-label="测试功能">
      <span className="settings-heading">测试功能</span>
      <span className="settings-hint">还在试的新功能，默认都关着。打开后入口才出现；用着别扭、出错可以随时关掉，关掉不影响任务和会话的数据。</span>
      {EXPERIMENTAL_FEATURES.filter((f) => !f.parent).map((f) => {
        const options = EXPERIMENTAL_FEATURES.filter((o) => o.parent === f.id);
        const tried = options.filter((o) => shown.includes(o.id)).length;
        return (
          <div key={f.id} className="feature-with-detail">
            {check(f)}
            {options.length > 0 && (
              <button type="button" className="btn-ghost small feature-detail-open" onClick={() => setDetail(f.id)} title={`${f.label}里已经有什么，还有哪些开发中的选项可以单独打开`} data-testid={`experimental-${f.id}-open`}>
                详细设置{tried ? ` · 开了 ${tried} 项` : ""} ›
              </button>
            )}
          </div>
        );
      })}
      {failed}
    </section>
  );
}
