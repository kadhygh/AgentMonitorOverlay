import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function reviewRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/scratchpad", () => service.review.scratchpad()),
    route("PUT", "/api/scratchpad", ({ body }) => service.review.saveScratchpad(obj(body).text)),
    route("GET", "/api/sessions/:id/annotations", ({ params }) => service.review.annotations(params.id!)),
    route("POST", "/api/sessions/:id/annotations/send", ({ params }) => service.review.sendAnnotations(params.id!)),
    route("POST", "/api/sessions/:id/annotations", ({ params, body }) => service.review.addAnnotation(params.id!, obj(body) as never)),
    route("PATCH", "/api/annotations/:id", ({ params, body }) => service.review.updateAnnotation(params.id!, obj(body).note as string)),
    route("DELETE", "/api/annotations/:id", ({ params }) => (service.review.deleteAnnotation(params.id!), { ok: true })),
  ];
}
