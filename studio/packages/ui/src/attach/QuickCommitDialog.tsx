import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QUICK_COMMIT } from "./mentions.js";

// 快速提交 (2026-10-26): from the composer's @ list or Ctrl+Shift+P, the person confirms what the model is to do with
// the local changes — commit them split by content and pull with a merge, and with the second choice push after. It
// starts on the first each time. Confirmed, the composer gets「@快速提交」 and the message says what it means.

const CHOICES: Array<{ push: boolean; label: string; hint: string }> = [
  { push: false, label: "提交 + 拉取合并", hint: "按改动内容自动拆成几条 commit，再 pull 合并上游；不推送" },
  { push: true, label: "提交 + 拉取合并 + 推送", hint: "同上，合并好以后 push 到上游" },
];

export function QuickCommitDialog({ onDone }: { onDone(push: boolean | null): void }) {
  const [push, setPush] = useState(false);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => confirm.current?.focus(), []);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onDone(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onDone(null);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "1" || e.key === "2") {
          e.preventDefault();
          setPush(e.key === "1" ? false : e.key === "2" ? true : !push);
        }
      }}
    >
      <div className="modal quickcommit-modal" role="dialog" aria-modal="true" aria-labelledby="quickcommit-title" data-testid="quickcommit-dialog">
        <span className="modal-title" id="quickcommit-title">
          快速提交
        </span>
        <span className="settings-hint">确认后在输入框里放一个「@{QUICK_COMMIT}」，发出去时按这里选的告诉模型怎么做。拿不准的改动和合并冲突，它会先问你。</span>
        <div className="quickcommit-choices" role="radiogroup" aria-label="做到哪一步">
          {CHOICES.map((c, i) => (
            <label key={c.label} className="quickcommit-choice" data-testid="quickcommit-choice">
              <input type="radio" name="quickcommit" checked={push === c.push} onChange={() => setPush(c.push)} />
              <span className="feature-text">
                <span>
                  {i + 1}. {c.label}
                </span>
                <span className="settings-hint">{c.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="settings-row end">
          <span className="settings-hint quickcommit-keys">↑↓ 或 1 / 2 选，回车确定</span>
          <button type="button" className="btn-ghost small" onClick={() => onDone(null)}>
            取消
          </button>
          <button ref={confirm} type="button" className="btn-primary small" onClick={() => onDone(push)} data-testid="quickcommit-ok">
            放进输入框
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
