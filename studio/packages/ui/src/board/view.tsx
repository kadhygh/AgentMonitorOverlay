import { Fragment } from "react";
import { call } from "../host/client.js";
import { mailByTask } from "../collab/useInbox.js";
import { checklistByTask } from "../collab/ChecklistPanel.js";
import { Board } from "./Board.js";
import { featureOn } from "../lib/features.js";
import type { BoardPanel, ViewDef } from "../shell/views.js";

/** The board: the tasks in scope by column, under the panels other features add (scheduler proposals). */
export function boardView(panels: readonly BoardPanel[]): ViewDef<"board"> {
  return {
    kind: "board",
    tab: { label: "看板", open: () => ({ kind: "board" }), alsoFor: ["task"] },
    render: (_view, ctx) => {
      const { link, state, scope, data, setView } = ctx;
      return (
        <>
          {panels.map((panel, i) => featureOn(ctx.disabled, panel.feature) && <Fragment key={i}>{panel.render(ctx)}</Fragment>)}
          <Board
            tasks={state.tasks}
            sessions={state.sessions}
            workspaces={state.workspaces}
            topics={state.topics}
            scope={scope}
            onOpen={(task) => setView({ kind: "task", taskId: task.id })}
            onMove={(task, column) => void call(link, "PATCH /api/tasks/:id", { id: task.id }, { column }).catch(() => undefined)}
            onArchive={(tasks) =>
              void (async () => {
                for (const task of tasks) await call(link, "POST /api/tasks/:id/archive", { id: task.id }).catch(() => undefined);
              })()
            }
            mail={mailByTask(data.unreadMail, state.sessions)}
            decisions={data.decisionsByTask}
            checklist={checklistByTask(data.checklist)}
          />
        </>
      );
    },
  };
}

