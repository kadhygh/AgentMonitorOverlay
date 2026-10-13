import type { HostService } from "../../service.js";
import { obj, route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function canvasRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/topics/:id/canvas", ({ params }) => service.canvases.canvas(params.id!)),
    route("PUT", "/api/topics/:id/canvas", ({ params, body }) => service.canvases.saveCanvas(params.id!, body)),
    route("GET", "/api/topics/:id/canvas/outline", ({ params }) => service.canvases.canvasOutline(params.id!)),
    route("PUT", "/api/tasks/:id/canvas", ({ params, body }) => service.canvases.setTaskOnCanvas(params.id!, obj(body))),
  ];
}
