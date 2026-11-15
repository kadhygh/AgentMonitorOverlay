import type { HostService } from "../../service.js";
import { route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function tracksRoutes(service: HostService): Route[] {
  return [
    route("GET /api/tracks", () => ({ on: service.tracks.listOn() })),
    // 远程副本 (remoteCopy, http/route.ts; 2026-11-15): a copy's building, and its 脉络会话 tick, are the other computer's.
    route("GET /api/sessions/:id/tracks", ({ params }) => service.tracks.view(params.id!)),
    route("PUT /api/sessions/:id/tracks", ({ params, body }) => service.tracks.view(params.id!, (body as { on?: unknown } | null)?.on ?? null), { remoteCopy: "forward" }),
  ];
}
