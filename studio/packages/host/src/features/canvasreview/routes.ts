import type { HostService } from "../../service.js";
import { obj, route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function canvasReviewRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/topics/:id/callouts", ({ params }) => service.canvasReview.callouts(params.id!)),
    route("GET", "/api/callouts/waiting", () => service.store.waitingQuestions()),
    route("POST", "/api/callouts/:id/answer", ({ params, body }) => service.canvasReview.answer(params.id!, obj(body))),
    route("POST", "/api/callouts/:id/close", ({ params }) => service.canvasReview.close(params.id!)),
    route("POST", "/api/topics/:id/canvas/items/:itemId/discuss", ({ params, body }) => service.canvasReview.discuss(params.id!, params.itemId!, obj(body))),
  ];
}
