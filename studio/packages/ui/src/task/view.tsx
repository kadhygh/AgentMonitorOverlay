import { TaskPage } from "./TaskPage.js";
import { backTo, type ViewDef } from "../shell/views.js";

/** One task: its sessions and conversation, notes, mail, decisions and checklist. "←" returns where it was opened from. */
export const taskView: ViewDef<"task"> = {
  kind: "task",
  render: (view, { link, state, data, setView }) => {
    const task = state.tasks.find((t) => t.id === view.taskId);
    if (!task) return <div className="placeholder">任务不存在或已被删除。</div>;
    const back = backTo(view.back);
    return (
      <TaskPage
        key={`${task.id}:${view.nav ?? 0}`}
        link={link}
        task={task}
        sessions={state.sessions}
        tasks={state.tasks}
        workspaces={state.workspaces}
        topics={state.topics}
        profiles={state.profiles}
        checklist={data.checklist.filter((i) => i.taskId === task.id)}
        {...(view.sessionId ? { initialSessionId: view.sessionId } : {})}
        {...(view.passage ? { passage: view.passage } : {})}
        justCreated={!!view.created}
        backLabel={back.label}
        onBack={() => setView(back.view)}
      />
    );
  },
};
