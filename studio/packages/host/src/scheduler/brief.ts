import type { ModelProfile, TodoItem, Workspace, WorkspaceActivity } from "@amo-studio/protocol";

// The first message of a scheduler round (design/scheduler.md): what is open, which projects are free, which models
// exist, and the rules. The agent answers by calling schedule_propose; it never starts work itself.

export interface SchedulerBriefInput {
  todos: readonly TodoItem[];
  workspaces: readonly Workspace[];
  activity: ReadonlyMap<string, WorkspaceActivity>;
  profiles: readonly ModelProfile[];
  perRound: number;
}

export function schedulerBrief(input: SchedulerBriefInput): string {
  const ws = (id: string | null) => (id ? (input.workspaces.find((w) => w.id === id)?.name ?? "?") : "未指定");
  const open = input.todos.filter((t) => !t.done && !t.taskId);
  const lines: string[] = [
    "你是 AMO Studio 的调度 agent。请看下面的整体待办和各工程是否空闲，挑出现在适合开工的待办，用 amo MCP 的 schedule_propose 工具为每一条提出提案。",
    "",
    "规则：",
    `- 只提案，不要自己开会话、不要修改文件、不要运行命令；提案要等人批准后才会开工。`,
    `- 这一轮最多提 ${input.perRound} 条；忙碌的工程不要提；没有合适的就不提，直接说明原因。`,
    "- 每条提案写清楚：todoId、workspace（工作区 id）、profileId（模型）、prompt（新会话的第一句话，具体到要做什么）、reason（一两句话：为什么是现在、为什么是这个工程）。",
    "- 提完后用一两句话总结你提了什么。",
    "",
    "## 整体待办（未完成）",
  ];
  if (!open.length) lines.push("（没有）");
  for (const t of open) lines.push(`- todoId=${t.id}：${t.text}（适合：${ws(t.workspaceId)}）`);
  lines.push("", "## 工程");
  for (const w of input.workspaces) {
    const a = input.activity.get(w.id);
    lines.push(`- ${w.name}（id=${w.id}）：${a?.idle === false ? `忙碌，${a.busy} 个会话在进行` : "空闲"}`);
  }
  lines.push("", "## 可用的模型");
  for (const p of input.profiles.filter((x) => !x.hidden)) lines.push(`- profileId=${p.id}：${p.label}`);
  return lines.join("\n");
}
