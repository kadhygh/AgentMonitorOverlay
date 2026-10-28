import { useState } from "react";
import type { CanvasDoc, CanvasGroup } from "@amo-studio/protocol";
import { ConfirmDialog } from "../lib/ConfirmDialog.js";
import { groupContents } from "./geometry.js";

/**
 * 删除分组 (2026-10-29, the user): the group alone by default — its cards stay where they are — or, ticked, with every
 * card in it. What each kind of card then means is said in words: a task's card only leaves the canvas (the task is not
 * deleted), notes, reference cards and review items are deleted.
 */
export function DeleteGroupDialog({ doc, group, onCancel, onConfirm }: { doc: CanvasDoc; group: CanvasGroup; onCancel(): void; onConfirm(withCards: boolean): void }) {
  const [withCards, setWithCards] = useState(false);
  const inside = groupContents(doc, group.id);
  const what = [
    inside.tasks ? `${inside.tasks} 张任务卡片从画布上拿掉，任务本身不删（还在专题里，依赖也保留）` : "",
    inside.notes ? `${inside.notes} 张便签会删除` : "",
    inside.refs ? `${inside.refs} 张引用卡片会删除，引用的任务不受影响` : "",
    inside.items ? `${inside.items} 条审阅条目会删除` : "",
  ].filter(Boolean);
  return (
    <ConfirmDialog title={`删除分组「${group.title}」？`} action={withCards ? `删除分组和 ${inside.total} 张卡片` : "删除分组"} danger onCancel={onCancel} onConfirm={() => onConfirm(withCards)} testId="delete-group-confirm">
      <label className="canvas-delete-check">
        <input type="checkbox" checked={withCards} onChange={(e) => setWithCards(e.target.checked)} data-testid="delete-group-cards" />
        同时删除组里的 {inside.total} 张卡片
      </label>
      <ul className="confirm-risks" data-testid="delete-group-what">
        {withCards ? what.map((line) => <li key={line}>{line}</li>) : <li>只删分组：{inside.total} 张卡片留在原处，不再属于任何分组。</li>}
      </ul>
    </ConfirmDialog>
  );
}
