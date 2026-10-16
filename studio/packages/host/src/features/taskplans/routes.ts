import type { HostService } from "../../service.js";
import { obj, route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function taskPlansRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/task-plans", () => service.taskPlans.list()),
    route("POST", "/api/task-plans/:id/accept", ({ params, body }) => service.taskPlans.accept(params.id!, obj(body) as never)),
    route("POST", "/api/task-plans/:id/dismiss", ({ params, body }) => service.taskPlans.dismiss(params.id!, obj(body) as never)),
  ];
}
