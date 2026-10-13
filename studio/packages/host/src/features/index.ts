import type { HostService } from "../service.js";
import type { Route } from "../http/route.js";
import type { AmoTool, ToolContext } from "../mcp/tool-kit.js";
import { projectsRoutes } from "./projects/routes.js";
import { projectsTools } from "./projects/mcp.js";
import { configRoutes } from "./config/routes.js";
import { tasksRoutes } from "./tasks/routes.js";
import { tasksTools } from "./tasks/mcp.js";
import { topicsRoutes } from "./topics/routes.js";
import { topicsTools } from "./topics/mcp.js";
import { sessionsRoutes } from "./sessions/routes.js";
import { sessionsTools } from "./sessions/mcp.js";
import { planningRoutes } from "./planning/routes.js";
import { planningTools } from "./planning/mcp.js";
import { collabRoutes } from "./collab/routes.js";
import { collabTools } from "./collab/mcp.js";
import { canvasRoutes } from "./canvas/routes.js";
import { canvasTools } from "./canvas/mcp.js";
import { reviewRoutes } from "./review/routes.js";
import { packsRoutes } from "./packs/routes.js";
import { packsTools } from "./packs/mcp.js";
import { attachmentsRoutes } from "./attachments/routes.js";
import { scratchpadRoutes } from "./scratchpad/routes.js";
import { gitReviewRoutes } from "./gitreview/routes.js";
import { filesRoutes } from "./files/routes.js";
import { openInRoutes } from "./openin/routes.js";
import { marksRoutes } from "./marks/routes.js";
import { marksTools } from "./marks/mcp.js";
import { chatFilesRoutes } from "./chatfiles/routes.js";

/**
 * Every Host feature (features/<name>/): its service class lives on HostService, its routes and MCP tools are listed
 * here. Adding a feature is a new folder plus a line here; removing one is the reverse (its tables stay: migrations
 * are never undone).
 */
export interface HostFeature {
  name: string;
  routes(service: HostService): Route[];
  /** Its tools for agents (mcp/tools.ts gathers them). */
  tools?(ctx: ToolContext): AmoTool[];
}

export const FEATURES: readonly HostFeature[] = [
  { name: "projects", routes: projectsRoutes, tools: projectsTools },
  { name: "config", routes: configRoutes },
  { name: "tasks", routes: tasksRoutes, tools: tasksTools },
  { name: "topics", routes: topicsRoutes, tools: topicsTools },
  { name: "sessions", routes: sessionsRoutes, tools: sessionsTools },
  { name: "planning", routes: planningRoutes, tools: planningTools },
  { name: "collab", routes: collabRoutes, tools: collabTools },
  { name: "canvas", routes: canvasRoutes, tools: canvasTools },
  { name: "review", routes: reviewRoutes },
  { name: "packs", routes: packsRoutes, tools: packsTools },
  { name: "attachments", routes: attachmentsRoutes },
  { name: "scratchpad", routes: scratchpadRoutes },
  { name: "gitreview", routes: gitReviewRoutes },
  { name: "files", routes: filesRoutes },
  { name: "openin", routes: openInRoutes },
  { name: "marks", routes: marksRoutes, tools: marksTools },
  { name: "chatfiles", routes: chatFilesRoutes },
];
