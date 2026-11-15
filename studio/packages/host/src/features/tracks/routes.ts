import type { HostService } from "../../service.js";
import { route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function tracksRoutes(service: HostService): Route[] {
  return [
    route("GET /api/tracks", () => ({ on: service.tracks.listOn() })),
    route("GET /api/sessions/:id/tracks", ({ params }) => service.tracks.get(params.id!)),
    route("PUT /api/sessions/:id/tracks", ({ params, body }) => service.tracks.setOn(params.id!, (body as { on?: unknown } | null)?.on)),
  ];
}
