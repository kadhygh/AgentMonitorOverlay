import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function tasksRoutes(service: HostService): Route[] {
  return [
    route("POST", "/api/tasks", ({ body }) => service.tasks.createTask(obj(body) as never)),
    route("PATCH", "/api/tasks/:id", ({ params, body }) => service.tasks.updateTask(params.id!, obj(body) as never)),
    route("POST", "/api/tasks/:id/sessions", ({ params, body }) => service.tasks.addSession(params.id!, obj(body) as never)),
    route("POST", "/api/tasks/:id/archive", ({ params }) => service.tasks.archiveTask(params.id!)),
    route("POST", "/api/tasks/:id/unarchive", ({ params }) => service.tasks.unarchiveTask(params.id!)),
  ];
}
