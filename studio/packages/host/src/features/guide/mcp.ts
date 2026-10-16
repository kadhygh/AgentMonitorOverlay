import { z } from "zod";
import { fail, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";
import { GUIDE_SECTIONS, guideText } from "./guide.js";
import { roleCard } from "./role.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts): who you are, and how AMO works. */
export function guideTools({ service, caller }: ToolContext): AmoTool[] {
  return [
    {
      name: "amo_whoami",
      title: "我的角色",
      description: "Your role card in AMO Studio: who you are (主控 / 执行 / 专题会话 / 分支), your task and its description, your project and topic, the topic's 主控, its documents, and what your role should and should not do. Call it before your first other AMO tool.",
      inputSchema: {},
      readOnly: true,
      autoApprove: true,
      run: () => (caller ? { content: [{ type: "text", text: roleCard(service, caller.sessionId) }] } : fail("这次调用没有 AMO 会话身份（例如由 Codex 自己派生的子 agent）：你在主会话的任务里做事，只能使用只读工具。")),
    },
    {
      name: "amo_guide",
      title: "AMO 用法",
      description: `How AMO Studio works and which tools to use, by section: ${GUIDE_SECTIONS.join(", ")} (overview when left out).`,
      inputSchema: { section: z.enum(GUIDE_SECTIONS).optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => ({ content: [{ type: "text", text: guideText(args.section === undefined ? undefined : String(args.section)) }] }),
    },
  ];
}
