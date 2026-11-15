import type { HostService } from "../../service.js";
import { route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function reviewProgressRoutes(service: HostService): Route[] {
  return [
    route("GET /api/sessions/:id/review-progress", ({ params }) => service.reviewProgress.get(params.id!)),
    // 远程副本 (remoteCopy, http/route.ts; 2026-11-16): what the person here has read of a copy is theirs, kept on this
    // computer like its 批注 — not sent to the computer the task runs on.
    route("PUT /api/sessions/:id/review-progress", ({ params, body }) => service.reviewProgress.update(params.id!, body as { seen?: unknown; reviewed?: unknown; unreviewed?: unknown } | null), { remoteCopy: "local" }),
  ];
}
