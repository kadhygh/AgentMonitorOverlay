// AMO Studio's full usage for agents (stage 16): amo_guide returns one section, or the overview with the list.

export const GUIDE_SECTIONS = ["overview", "tasks", "topics", "canvas", "collab", "lead", "files"] as const;
export type GuideSection = (typeof GUIDE_SECTIONS)[number];

const GUIDE: Record<GuideSection, string> = {
  overview: `# AMO Studio 是什么

人在 AMO Studio 里管理和 AI 一起做的工作。你是其中一个会话。

- **项目**（workspace）：一个文件夹，通常是一个 git 工程。
- **任务**：一件要做的事，属于一个项目，可以放进一个专题。每个任务有自己的会话（你可能就是其中之一）、看板上的状态（todo / doing / review / done）、说明、进度记录和交接摘要。
- **专题**：几个相关的任务（可以跨项目）放在一张**画布**上，画布上有分组、任务之间的依赖、便签、颜色标记，还有**专题文档**。
- **主控**：人标记的、负责协调一个专题（或项目）的任务。主控拆任务、排画布、写专题文档；具体的活由各任务的会话做，人直接和每个任务对话。
- **人**：在看板、画布、任务页里看你的工作。人决定什么时候开分支、什么时候合并；Studio 不替人做这些。

先调 amo_whoami 看自己的角色。各部分的用法：amo_guide 加 section（tasks / topics / canvas / collab / lead / files）。`,
  tasks: `# 任务

- board_list：看板上的任务（可按项目、专题、状态筛选）。task_get：一个任务的详情（说明、依赖、分组、进度、会话）。
- task_describe：写任务说明（自己的任务，或同专题的任务）。说明显示在画布卡片和任务页上，几行讲清楚要做什么、目标和范围。
- task_note_add：在自己的任务上记一条进度。handoff_submit：交接摘要（这轮做了什么、还剩什么），下一个会话或人接着看。
- checklist_check：勾自己任务的清单项（来自扩展包模板）。
- session_tree：一个任务的会话树（主会话、分支、子 agent）。`,
  topics: `# 专题

- topic_list / topic_get：专题、它的项目、任务和状态、它自己的会话、画布大纲。
- topic_docs：专题文档（只和推进这个专题的任务有关：计划、决定、各部分怎么衔接）。不带 docId 列出全部，带 docId 读一篇。
- topic_doc_write：主控（或专题会话）写专题文档：新建（不带 docId）或改写（带 docId）。很专门的文档放在项目里，用文件标记标出来，专题文档里写上它的路径。`,
  canvas: `# 画布

- canvas_read：专题画布的结构（没有坐标）：分组和里面的任务、引用卡片（别的专题的任务）、便签、未分组的、还没放上去的任务、依赖。带说明和颜色。
- canvas_group_create：建一个分组（可绑定项目）。canvas_place：把任务放进分组或拿出来。canvas_depend：连依赖（from 做完 to 才开始，不能成环）。这三个每次要人批准。
- canvas_color：给任务卡、引用卡、便签或分组标颜色（red / yellow / green / blue，none 取消）。颜色是什么意思由人定（状态、优先级……），不要随意改人标的颜色。`,
  collab: `# 协作

- mailbox_send：给一个会话、任务或专题留言；mailbox_read：读给你的留言。留言什么时候进对话由人决定。
- decision_request：请人拍板（给几个选项）；答案作为留言回来。
- 不要直接改别的任务的文件或会话；需要别的任务配合时留言给它（或它的主控）。`,
  lead: `# 主控

人把你的任务标成了主控时：

1. 先读专题（topic_get、canvas_read、topic_docs），弄清目标。
2. 把大的工作拆成平级的任务，每个任务在合适的项目里、有清楚的说明。任务由人确认后才建（拆任务的提案工具会在之后加入；现在先在回复里列出拆分方案，或用 decision_request 请人确认）。
3. 在画布上排好：分组、依赖、颜色；给每个任务写说明（task_describe）。
4. 把计划、约定、决定写进专题文档（topic_doc_write），别的任务的会话会读。
5. 具体的活交给各任务的会话去做，你通过留言（mailbox_send）协调；不要把重活都放进自己的子 agent 里——人只能和你对话，内容要多出一份。
6. 分支和合并：人说开才开、说合才合。`,
  files: `# 文件和项目

- project_context：项目的说明、路径、git 分支等。
- list_file_marks：人标记的重要文件（带备注和行号范围）；专门的文档在项目里时，人会用文件标记标出来。
- pack_list / pack_doc：项目的扩展包（约定、模板）。`,
};

export function guideText(section?: string): string {
  if (section && (GUIDE_SECTIONS as readonly string[]).includes(section)) return GUIDE[section as GuideSection];
  return `${GUIDE.overview}\n\n可选的 section：${GUIDE_SECTIONS.join("、")}。`;
}
