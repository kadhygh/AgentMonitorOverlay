import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function dshRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/dsh", () => service.dsh.status()),
    route("PUT", "/api/dsh", ({ body }) => service.dsh.update(obj(body))),
    route("POST", "/api/dsh/check", () => service.dsh.check()),
    route("GET", "/api/dsh/folders", () => service.dsh.folders()),
    route("GET", "/api/dsh/folders/:workspaceId", ({ params }) => service.dsh.folder(params.workspaceId!)),
    route("POST", "/api/dsh/folders/:workspaceId/fix", ({ params }) => service.dsh.setupFolder(params.workspaceId!)),
    route("POST", "/api/dsh/folders/:workspaceId/scan", ({ params }) => service.dsh.scanFolder(params.workspaceId!)),
    route("POST", "/api/sessions/:id/folder-access", ({ params }) => service.dsh.fixFolderAccess(params.id!)),
  ];
}
