import type { HostService } from "../service.js";
import type { Route } from "../http/route.js";
import { projectsRoutes } from "./projects/routes.js";
import { configRoutes } from "./config/routes.js";
import { tasksRoutes } from "./tasks/routes.js";
import { topicsRoutes } from "./topics/routes.js";
import { sessionsRoutes } from "./sessions/routes.js";
import { planningRoutes } from "./planning/routes.js";
import { collabRoutes } from "./collab/routes.js";
import { canvasRoutes } from "./canvas/routes.js";
import { reviewRoutes } from "./review/routes.js";
import { packsRoutes } from "./packs/routes.js";

/**
 * Every Host feature (features/<name>/): its service class lives on HostService, its routes are listed here. Adding a
 * feature is a new folder plus a line here; removing one is the reverse (its tables stay: migrations are never undone).
 */
export interface HostFeature {
  name: string;
  routes(service: HostService): Route[];
}

export const FEATURES: readonly HostFeature[] = [
  { name: "projects", routes: projectsRoutes },
  { name: "config", routes: configRoutes },
  { name: "tasks", routes: tasksRoutes },
  { name: "topics", routes: topicsRoutes },
  { name: "sessions", routes: sessionsRoutes },
  { name: "planning", routes: planningRoutes },
  { name: "collab", routes: collabRoutes },
  { name: "canvas", routes: canvasRoutes },
  { name: "review", routes: reviewRoutes },
  { name: "packs", routes: packsRoutes },
];
