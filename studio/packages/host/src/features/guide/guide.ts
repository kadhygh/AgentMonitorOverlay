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
- task_note_add：在自己的任务上记一条进度，人让你记时才用，平时不用主动记。handoff_submit：交接摘要（做了什么、还剩什么），工作要交给下一个会话或人接手时用。
- checklist_check：勾自己任务的清单项（来自扩展包模板）。
- session_tree：一个任务的会话树（主会话、分支、子 agent）。`,
  topics: `# 专题

- topic_list / topic_get：专题、它的项目、任务和状态、它自己的会话、画布大纲。
- topic_docs：专题文档（只和推进这个专题的任务有关：计划、决定、各部分怎么衔接）。不带 docId 列出全部，带 docId 读一篇。
- topic_doc_write：主控（或专题会话）写专题文档：新建（不带 docId）或改写（带 docId）。很专门的文档放在项目里，人会把它加到书签，专题文档里写上它的路径。`,
  canvas: `# 画布

- canvas_read：专题画布的结构（没有坐标）：分组和里面的任务、引用卡片（别的专题的任务）、便签、未分组的、还没放上去的任务、依赖。带说明和颜色。
- canvas_group_create：建一个分组（可绑定项目）。canvas_place：把任务放进分组或拿出来。canvas_depend：连依赖（from 做完 to 才开始，不能成环）。这三个每次要人批准。
- canvas_color：给任务卡、引用卡、便签或分组标颜色（red / yellow / green / blue，none 取消）。颜色是什么意思由人定（状态、优先级……），不要随意改人标的颜色。`,
  collab: `# 协作

- mailbox_send：给一个会话、任务或专题留言；mailbox_read：读给你的留言。留言什么时候进对话由人决定。
- decision_request：请人拍板（给几个选项）；答案作为留言回来。
- session_start：在你自己的任务里再开一个会话（不用人确认），把一部分活并行交出去或换个干净的上下文；第一句话要写够让它能独立开工。需要它的结果时带 report: true，它每一轮做完后回复会作为消息回到你的对话里（被人停下、出错也会告诉你）；不需要就不带。可以用 model 换一个模型（amo_whoami 列出的名字）：强模型额度紧时，把调查和照计划改代码交给便宜的模型，你出计划、它执行，计划要写到它不用再问就能做（改哪些文件、怎么改、怎么验证）。它在会话列表里挂在你下面，但是独立的会话：你归档时它不跟着归档。它默认在任务的文件夹里工作、用那个模型的默认权限（常常是沙箱）；活在别的项目里时（例如任务在公共空间、代码在某个项目里）带 workspace（project_context 里的项目名或路径），要连续跑很多命令时带 permission: "full"（只读调查用 "read-only"），免得每条命令都等人批准。思考强度用 effort（low、medium、high、xhigh、max 等，能用哪些看模型；填错了会告诉你能用的值），简单的活用低的省额度，难的用高的；不带就用人设的默认。
- 不要直接改别的任务的文件或会话；需要别的任务配合时留言给它（或它的主控）。`,
  lead: `# 主控

人把你的任务标成了主控时：

1. 先读专题（topic_get、canvas_read、topic_docs），弄清目标。
2. 把大的工作拆成平级的任务，每个任务在合适的项目里、有清楚的说明和能独立开工的第一句话：用 task_plan_propose 提案。人在画布上确认（可以改）后 Studio 才建任务、放上画布、连好依赖；结果作为留言回来（带新任务的 id）。
3. 在画布上排好：分组、依赖、颜色；给每个任务写说明（task_describe）。
4. 把计划、约定、决定写进专题文档（topic_doc_write），别的任务的会话会读。
5. 具体的活交给各任务的会话去做。要它们马上知道的（决定、计划改了、下一步）用 relay_send 传话：人确认后（或任务设了不用确认）直接送进它的会话；不急的用 mailbox_send 留言。不要把重活都放进自己的子 agent 里——人只能和你对话，内容要多出一份。
6. 分支和合并：人说开才开、说合才合。`,
  files: `# 文件和项目

- project_context：项目的说明、路径、git 分支等。
- list_file_marks：人加到书签里的重要文件（带说明和行号范围）；专门的文档在项目里时，人会把它加到书签。
- view_open：给人看东西（查看包）：一次调用里放进要看的所有条目，左边列表、右边预览。kind: file 看文件现状，用 highlights 标出重点行并写明为什么；kind: git 看改动（source: working 未提交 / base / commit / range），files 是要人重点看的文件（列在最上面，其余改动列在下面照样能看），highlights 标出改动文件里的重点行（每条带 path，行号按新版本）；kind: proposal 给出你建议但还没做的改动（path + 改后的完整内容），显示成对比，磁盘上不改。不要一个文件调一次；几秒内再调会加进同一个窗口。人写的批注由人复制后贴回来（通常贴给你），不会自动回到对话。
- review_open：让人审阅文件。mode: file 加 file 打开磁盘上的当前文件，可带 line / endLine 定位行号；mode: changes（默认）看 Git 改动，可带 file 选中文件，base 对比指定 ref，commit / range 看提交范围（只读）。默认当前项目；人写的批注由人复制后贴回来，不会自动回到对话。保存修改后再调一次就会重新读取；不代表人已审阅或批准。
- pack_list / pack_doc：项目的扩展包（约定、模板）。`,
};

export function guideText(section?: string): string {
  if (section && (GUIDE_SECTIONS as readonly string[]).includes(section)) return GUIDE[section as GuideSection];
  return `${GUIDE.overview}\n\n可选的 section：${GUIDE_SECTIONS.join("、")}。`;
}
