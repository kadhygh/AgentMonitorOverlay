import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function planningRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/todos", () => service.planning.todos()),
    route("POST", "/api/todos", ({ body }) => service.planning.addTodo(obj(body))),
    route("PATCH", "/api/todos/:id", ({ params, body }) => service.planning.updateTodo(params.id!, obj(body))),
    route("POST", "/api/todos/:id/convert", ({ params, body }) => service.planning.convertTodo(params.id!, obj(body))),
    route("DELETE", "/api/todos/:id", ({ params }) => (service.planning.deleteTodo(params.id!), { ok: true })),
    route("POST", "/api/scheduler/run", ({ body }) => service.planning.runScheduler(obj(body))),
    route("GET", "/api/proposals", ({ query }) => service.planning.proposals(query.get("state") ? { state: query.get("state") as never } : {})),
    route("POST", "/api/proposals", ({ body }) => service.planning.propose(obj(body))),
    route("POST", "/api/proposals/:id/approve", ({ params, body }) => service.planning.approveProposal(params.id!, obj(body))),
    route("POST", "/api/proposals/:id/reject", ({ params }) => service.planning.rejectProposal(params.id!)),
  ];
}
