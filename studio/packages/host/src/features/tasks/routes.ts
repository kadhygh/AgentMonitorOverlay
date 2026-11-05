import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function tasksRoutes(service: HostService): Route[] {
  return [
    route("POST", "/api/tasks", ({ body }) => service.tasks.createTask(obj(body) as never)),
    route("GET", "/api/claude/outside-sessions", () => service.tasks.outsideSessions()),
    route("GET", "/api/claude/outside-sessions/:id/preview", ({ params }) => service.tasks.outsidePreview(params.id!)),
    // 远程副本 (remoteCopy, http/route.ts): a copy is renamed on A (2026-10-30; TasksFeature.updateTask refuses its other
    // changes), gets new sessions there, and archiving it deletes the copy.
    route("PATCH", "/api/tasks/:id", ({ params, body }) => service.tasks.patchTask(params.id!, obj(body) as never), { remoteCopy: "forward" }),
    route("POST", "/api/tasks/:id/sessions", ({ params, body }) => service.tasks.addSession(params.id!, obj(body) as never), { remoteCopy: "forward" }),
    route("POST", "/api/tasks/:id/archive", ({ params }) => service.tasks.archiveTask(params.id!), { remoteCopy: "forward" }),
    route("POST", "/api/tasks/:id/unarchive", ({ params }) => service.tasks.unarchiveTask(params.id!)),
  ];
}
