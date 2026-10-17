import type { Annotation } from "@amo-studio/protocol";
import { formatTokens, type sessionStats } from "../chat/turns.js";
import { flashAnnotation } from "../review/highlights.js";
import { annotationNumber, type AnnotationRefs } from "../review/annotationRefs.js";

// Pieces of the conversation and its composer (stage 16 split out of Thread.tsx).

/** What the composer says in its empty box: why it is read-only, or how a message goes now. */
export function composerPlaceholder(s: { readOnly: boolean; claudeSub: boolean; isRevising: boolean; planReview: boolean; generating: boolean; queues: boolean; waitsForTurn?: boolean }): string {
  return s.readOnly
    ? s.claudeSub
      ? "Claude 的子 agent 不能单独接收消息，请在父会话里继续。"
      : "会话已交给终端，工作台暂时只读。"
    : s.isRevising
      ? "写下要修改的地方，回车发给 Claude（计划会按你的意见重写）"
      : s.planReview
        ? "计划在等你审阅：可以先在这里写下意见，再点上面的「要修改」"
        : s.generating
          ? s.waitsForTurn
            ? "回复生成中，发出的内容会在这一轮结束后发给它"
            : s.queues
              ? "回复生成中，发出的内容会在下一次工具调用后或本轮结束后被读到"
              : "回复生成中，输入的内容会作为插话发出"
          : "继续推进这个会话，回车发送，Shift+回车换行，输入 / 看命令";
}

/** The right-click menu on selected text in a reply. */
export function SelectionMenu({ at, canQuote, onAnnotate, onQuote, onCopy }: { at: { x: number; y: number }; canQuote: boolean; onAnnotate(): void; onQuote(): void; onCopy(): void }) {
  return (
    <div className="ctx-menu" role="menu" aria-label="选中文字" style={{ left: at.x, top: at.y }}>
      <button type="button" role="menuitem" onClick={onAnnotate}>
        添加批注
      </button>
      <button type="button" role="menuitem" disabled={!canQuote} onClick={onQuote}>
        引用到输入框
      </button>
      <button type="button" role="menuitem" onClick={onCopy}>
        复制
      </button>
    </div>
  );
}

/** The 批注N tags of the annotations the next message refers to. */
export function AnnotationRefChips({ refs, annotations }: { refs: AnnotationRefs; annotations: readonly Annotation[] }) {
  return (
    <div className="anno-refs" aria-label="这条消息引用的批注" data-testid="annotation-refs">
      {refs.list.map((a) => (
        <span key={a.id} className="anno-ref" title={`「${a.quote}」\n${a.note}`} data-testid="annotation-ref">
          <button type="button" className="anno-ref-name" onClick={() => flashAnnotation(a.id)}>
            批注{annotationNumber(a, annotations)}
          </button>
          <button type="button" className="anno-ref-x" aria-label={`不引用批注${annotationNumber(a, annotations)}`} title="这条消息不引用它" onClick={() => refs.remove(a.id)}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

/** Under the composer: turns and steps, usage, cache hits, the context in use, and 压缩. */
export function ComposerStats({
  stats,
  canCompact,
  busy,
  compacting,
  onCompact,
}: {
  stats: ReturnType<typeof sessionStats>;
  canCompact: boolean;
  busy: boolean;
  compacting: boolean;
  onCompact(): void;
}) {
  if (stats.turns <= 0) return null;
  return (
    <div className="composer-stats" data-testid="composer-stats">
      <span>
        {stats.turns} 轮 {stats.steps} 步
      </span>
      {stats.tokens > 0 && <span>用量 {formatTokens(stats.tokens)}</span>}
      {stats.subTokens > 0 && (
        <span title="子 agent 自己用掉的，不在左边的用量里" data-testid="sub-usage">
          子 agent {formatTokens(stats.subTokens)}
        </span>
      )}
      {stats.cacheHit !== null && <span>缓存命中 {stats.cacheHit}%</span>}
      {stats.context && (
        <span className={`context-use${stats.context.percent !== null && stats.context.percent >= 80 ? " high" : ""}`} title="当前上下文 / 模型最大上下文（最近一轮结束时）" data-testid="context-use">
          上下文 {formatTokens(stats.context.used)}
          {stats.context.window ? ` / ${formatTokens(stats.context.window)} · ${stats.context.percent}%` : ""}
        </span>
      )}
      {canCompact && (
        <button type="button" className="link-btn compact-btn" data-testid="compact-button" disabled={busy} title="压缩上下文：把之前的对话总结成摘要，腾出上下文空间（等这一轮结束后可用）" onClick={onCompact}>
          {compacting ? "压缩中…" : "压缩"}
        </button>
      )}
    </div>
  );
}
