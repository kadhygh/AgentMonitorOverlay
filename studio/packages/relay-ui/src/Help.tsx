import { useEffect, useRef } from "react";
import { Dialog } from "./Dialog.js";
import { Markdown } from "./Markdown.js";

// 说明 (2026-11-05, the user: 增加一些方案的说明): what the states and buttons mean, short, one line each. Opened from the
// left column's 说明, or from the ? by a session's state (at 「状态」). It comes with the content, so it changes with it.

export type HelpSection = "what" | "states" | "buttons" | "copy" | "rules" | "studio";

const SECTIONS: Array<{ id: HelpSection; title: string; body: string }> = [
  {
    id: "what",
    title: "会话是什么",
    body: `- 会话是一个人（多半是他的 AI）发给另一个人、要对方处理的一件事。比如策划的 AI 做完一轮，请程序确认方案。
- 会话始终在某个人手里：对方处理完交回来，发起人（或他的 AI）接着推进，直到结束。
- 人和人随便聊，用「聊天」，不用会话。`,
  },
  {
    id: "states",
    title: "状态",
    body: `- **等你处理**：在你手里。回复它，或者看过了不用回就点「已接手，不用回复」。
- **等 X 处理**：在对方手里，你不用动。
- **回复已到 · 复制给 AI 继续**：对方回复了你的 AI 发的会话。用 AMO Studio 发的会自己回到原来的对话；别的 AI，点「复制新回复」贴回原来的对话。
- **AI 已取回，正在处理**：你的 AI 拿到了回复，会继续追问或者结束。
- **可能卡住了**：AI 拿到回复后很久没动静（对话结束了，或者在等你），复制回复给它，或者点「我来处理」。
- **X 已接手 · 不用回复**：对方看过了，不需要回复，事情由对方去做；会话已结束。发起的 AI 默认不会收到消息，只有对方勾了「把附言转给 AI」才会。
- **已完成**：结束了。任何一方都能「重新打开」。`,
  },
  {
    id: "buttons",
    title: "按钮",
    body: `- **回复并返回**（收件人）：逐条回答、写说明、选结论，发出后会话回到发起人手里。
- **已接手，不用回复**（收件人）：看过了、不需要回复时用，会话结束。可以写一句附言；发起人是 AI 时，可以勾选把附言转给它（它会再跑一轮），默认不转。
- **标记完成**：结束会话。AI 发来的会话只有发起方能标记完成；收件人不用回时用「已接手」。
- **撤回并标记完成**（发起人）：不用对方处理了。
- **继续追问**（发起人）：用话再问，或者加几个逐条回答的问题，会话回到对方手里。
- **我来处理 / 交还给 AI**（发起人）：从自己的 AI 手里接过来自己处理；处理完可以交还给 AI。
- **再回复一次**（收件人）：已经回复过，还想补充或改结论。
- **接手任务…**（团队任务里的会话）：把团队任务流转到你手里，和「已接手」不是一回事。`,
  },
  {
    id: "copy",
    title: "复制给 AI",
    body: `- **复制给 AI / 复制整个会话**：整个会话，加上附件上的批注，贴给新对话。
- **复制新回复**：只复制你上次发言之后的回复和批注，贴回原来的对话。
- **复制取回指令**：一句话，让 agent 自己去中转取这条回复。
- 批注的写法和 AMO Reviewer 复制的一样：\`文件名:行号\`，\`>\` 后面是引用的原文，下面是批注内容和写的人。`,
  },
  {
    id: "rules",
    title: "规矩",
    body: `- AI 发来的会话一定要处理：回复，或者「已接手，不用回复」。不能直接标记完成。
- 批注：打开附件，选中一段文字，点「写批注」。回复时勾「附上我的批注」会一起发给对方；复制给 AI 时附件上的批注都会带上。
- 不能给自己发会话：你的 AI 用的就是你的身份。`,
  },
  {
    id: "studio",
    title: "和 AMO Studio 一起用",
    body: `- Studio 里的会话用 team_ask 发的中转会话，回复会自己回到那个会话，不用复制。
- 这台电脑上的 Studio 开着时，会话上方有「在 Studio 里打开」，去发起它的那个对话。
- 在 Studio 的任务页，「等 X 回复（中转）」旁边有「在中转里打开」，跳到这里的会话。`,
  },
];

export function HelpDialog({ section, onClose }: { section?: HelpSection; onClose: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (section) body.current?.querySelector(`[data-help="${section}"]`)?.scrollIntoView({ block: "start" });
  }, [section]);
  return (
    <Dialog title="中转怎么用" sub="状态和按钮是什么意思" onClose={onClose} wide className="help">
      <div className="help-body" ref={body}>
        <nav className="help-nav" aria-label="说明目录">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className="link" onClick={() => body.current?.querySelector(`[data-help="${s.id}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" })}>
              {s.title}
            </button>
          ))}
        </nav>
        {SECTIONS.map((s) => (
          <section key={s.id} data-help={s.id} className={`help-part ${s.id === section ? "hot" : ""}`}>
            <h3>{s.title}</h3>
            <Markdown source={s.body} />
          </section>
        ))}
      </div>
    </Dialog>
  );
}
