import { z } from "zod";
import { experimentalEnabled } from "@amo-studio/protocol";
import { write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). None while 脉络 (设置 → 测试功能) is off. */
export function tracksTools({ service, caller }: ToolContext): AmoTool[] {
  if (!experimentalEnabled(service.config.experimentalFeatures(), "tracks")) return [];
  return [
    {
      name: "track_note",
      title: "脉络：写这一轮",
      description:
        "Only in a 脉络会话 (the person sees this session as a building, a floor per round; you are told when it is one): near the end of a round, call it once to label the round's floor — title: what the round did (about 12 Chinese characters), desc: one line with the result or where it stands (about 30 characters). points: what the person stressed or what was settled in this round, one sentence each (kept in a list beside the building); done: ids of earlier points that are dealt with now (the answer lists the open ones). Write only what is new in this round, and do not start another turn just to call it.",
      inputSchema: { title: z.string().optional(), desc: z.string().optional(), points: z.array(z.string()).optional(), done: z.array(z.string()).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => write(caller, (c) => service.tracks.note(c.sessionId, args)),
    },
  ];
}
