import { useEffect, useState } from "react";
import { call, type ChangelogEntry, type ChangelogView, type PlatformView } from "./bridge.js";

// 更新记录 (2026-11-06, the user: 「现在只是拉到后给看一下，点了 x 就看不了了」 — the version to come, the one here and the
// ones before, with their notes, any time). A page of its own in the content area, opened from a tool's card or from
// 设置 → 平台更新, left with 返回. The list comes from the main process (Platform.changelog) when it opens, and again when
// the channel, the versions or the connection change.

export function ChangelogPage({ tool, view, backLabel, onBack }: { tool: string; view: PlatformView; backLabel: string; onBack: () => void }) {
  const [log, setLog] = useState<ChangelogView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = view.tools.find((x) => x.id === tool);
  const versions = t ? `${t.installed}|${t.available}` : `${view.self.installed}|${view.self.available}`;
  const key = `${view.channel}|${view.connection.state}|${versions}`;

  useEffect(() => {
    let live = true;
    call("changelog", tool).then(
      (v) => {
        if (!live) return;
        setLog(v);
        setError(null);
      },
      (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [tool, key]);

  const channelName = view.channel === "test" ? "测试通道" : "稳定通道";
  const coming = log?.entries.filter((e) => e.coming) ?? [];
  return (
    <div className="pf-page" data-testid="pf-changelog">
      <div>
        <button type="button" className="pf-link pf-back" onClick={onBack} data-testid="pf-changelog-back">
          ← 返回{backLabel}
        </button>
      </div>
      <div>
        <h1 className="pf-h1">{log?.name ?? t?.name.replace(/（独立版）$/, "") ?? (tool === "platform" ? "AMO 平台" : tool)} 更新记录</h1>
        <p className="pf-hint">每个版本改了什么，新的在上面。列到{channelName}里的最新版为止。</p>
      </div>
      {error && (
        <div className="pf-banner error" role="alert">
          <span>! 读不到更新记录：{error}</span>
        </div>
      )}
      {!log && !error && <p className="pf-hint">正在读取…</p>}
      {log && (
        <>
          <dl className="pf-facts pf-log-facts" data-testid="pf-changelog-facts">
            <dt>当前版本</dt>
            <dd>{currentText(log)}</dd>
            <dt>可以更新到</dt>
            <dd>{availableText(log, channelName, coming.length)}</dd>
          </dl>
          {log.offline && (
            <div className="pf-banner warn" role="status">
              <span>! 现在连不上服务器，下面只有这台电脑上装过的版本带着的记录。</span>
            </div>
          )}
          {log.source === "partial" && log.entries.length > 0 && (
            <p className="pf-hint" data-testid="pf-changelog-partial">
              这些版本发布时还没有带上完整的更新记录，所以这里只有这台电脑知道的几个版本（可以更新到的、装过的）。之后发布的版本会带上以前所有版本的记录。
            </p>
          )}
          {log.entries.length === 0 && <p className="pf-hint">服务器上和这台电脑上都还没有它的改动说明。</p>}
          {coming.length > 0 && (
            <p className="pf-log-lead" data-testid="pf-changelog-lead">
              更新到 {log.available} 会带来下面 {coming.length} 个版本的改动（标着「还没装」的）。
            </p>
          )}
          <ol className="pf-log-list">
            {log.entries.map((e) => (
              <Entry key={e.version} entry={e} log={log} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function currentText(log: ChangelogView): string {
  if (!log.installed) return "没装";
  if (log.running) return `${log.installed}（已经装好；正在运行的还是 ${log.running}，在「设置 → 平台更新」点「重启平台」后换成它）`;
  return log.installed;
}

function availableText(log: ChangelogView, channelName: string, coming: number): string {
  if (!log.available) return log.offline ? "不知道（连不上服务器）" : `${channelName}里没有它`;
  if (!log.installed) return `${log.available}（${channelName}，还没装）`;
  if (coming > 0) return `${log.available}（${channelName}，比当前版本新 ${coming} 个版本）`;
  if (log.available === log.installed) return `没有更新：当前版本就是${channelName}里的最新版`;
  return `没有更新：${channelName}里是 ${log.available}，比当前版本旧`;
}

function Entry({ entry: e, log }: { entry: ChangelogEntry; log: ChangelogView }) {
  const tags: Array<{ text: string; tone: "coming" | "here" | "plain" }> = [];
  if (e.installed) tags.push({ text: "✓ 当前版本", tone: "here" });
  if (e.coming) tags.push({ text: "○ 还没装", tone: "coming" });
  if (e.available && !e.installed) tags.push({ text: log.installed ? (e.coming ? "可以更新到" : "通道里的版本") : "服务器上的版本", tone: e.coming ? "coming" : "plain" });
  return (
    <li className={`pf-log-entry${e.coming ? " coming" : ""}${e.installed ? " here" : ""}`} data-testid={`pf-log-${e.version}`}>
      <div className="pf-log-head">
        <span className="pf-log-version">{e.version}</span>
        {e.date && <span className="pf-log-date">{e.date}</span>}
        {tags.map((x) => (
          <span key={x.text} className={`pf-log-tag ${x.tone}`}>
            {x.text}
          </span>
        ))}
      </div>
      <div className="pf-log-notes">{e.notes}</div>
    </li>
  );
}
