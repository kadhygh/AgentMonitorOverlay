import type { HostService } from "../../service.js";
import { route, type Route, str, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function projectsRoutes(service: HostService): Route[] {
  return [
    route("POST", "/api/workspaces", ({ body }) => {
      const b = obj(body);
      return service.projects.addWorkspace({ path: str(b.path, "path"), ...(typeof b.name === "string" ? { name: b.name } : {}) });
    }),
    route("DELETE", "/api/workspaces/:id", ({ params }) => (service.projects.removeWorkspace(params.id!), { ok: true })),
    route("PATCH", "/api/workspaces/:id", ({ params, body }) => service.projects.updateWorkspace(params.id!, obj(body))),
    route("POST", "/api/workspaces/:id/archive", ({ params }) => service.projects.archiveWorkspace(params.id!)),
    route("POST", "/api/workspaces/:id/unarchive", ({ params }) => service.projects.unarchiveWorkspace(params.id!)),
  ];
}
