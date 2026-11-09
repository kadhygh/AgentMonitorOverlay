import { useEffect, useState } from "react";
import { EXPERIMENTAL_FEATURES, type ExperimentalFeature } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

// 设置 → 测试功能 (2026-11-01, the user: 设置里加个测试功能页，这个功能加个开关): features still being tried out, each
// off until turned on. Kept by the Host like 功能, so both windows follow the settings event; but the list here is the
// ones turned on (功能's is the ones turned off).

export function ExperimentalSection({ link, on }: { link: HostLink; on: readonly ExperimentalFeature[] }) {
  // Shown at once; the Host's settings event confirms it (or the error puts it back).
  const [shown, setShown] = useState<readonly ExperimentalFeature[]>(on);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <section className="settings-section" aria-label="测试功能">
      <span className="settings-heading">测试功能</span>
      <span className="settings-hint">还在试的新功能，默认都关着。打开后入口才出现；用着别扭、出错可以随时关掉，关掉不影响任务和会话的数据。</span>
      {EXPERIMENTAL_FEATURES.map((f) => (
        <label key={f.id} className="settings-row feature-row">
          <input type="checkbox" checked={shown.includes(f.id)} disabled={busy} onChange={(e) => void toggle(f.id, e.target.checked)} data-testid={`experimental-${f.id}`} />
          <span className="feature-text">
            <span className="settings-label">
              {f.label}
              {f.stage === "dev" && (
                <span className="settings-tag feature-stage" data-testid={`experimental-${f.id}-stage`}>
                  开发中
                </span>
              )}
            </span>
            <span className="settings-hint">{f.hint}</span>
          </span>
        </label>
      ))}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </section>
  );
}
