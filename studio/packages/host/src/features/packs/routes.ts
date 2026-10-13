import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function packsRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/workspaces/:id/packs", ({ params }) => service.extensions.packs(params.id!)),
    route("GET", "/api/workspaces/:id/packs/:pack/docs/:doc", ({ params }) => service.extensions.packDoc(params.id!, params.pack!, params.doc!)),
    route("POST", "/api/workspaces/:id/packs/:pack/presets/:preset/draft", ({ params, body }) => service.extensions.presetDraft(params.id!, params.pack!, params.preset!, obj(body).taskId)),
  ];
}
