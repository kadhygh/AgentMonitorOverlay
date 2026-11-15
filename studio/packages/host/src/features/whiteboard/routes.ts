import type { HostService } from "../../service.js";
import { route, type Route } from "../../http/route.js";

const obj = (body: unknown): Record<string, unknown> => (body && typeof body === "object" ? (body as Record<string, unknown>) : {});

/**
 * The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). 远程副本: the writes
 * are refused for a copy (http/route.ts, no remoteCopy) — a remote task's board is not done yet (plans/whiteboard.md).
 */
export function whiteboardRoutes(service: HostService): Route[] {
  return [
    route("GET /api/whiteboards", () => ({ on: service.whiteboard.listOn().map((sessionId) => service.whiteboard.mark(sessionId)) })),
    route("GET /api/sessions/:id/whiteboard", ({ params }) => service.whiteboard.get(params.id!)),
    route("PUT /api/sessions/:id/whiteboard", ({ params, body }) => service.whiteboard.set(params.id!, obj(body))),
    route("POST /api/sessions/:id/whiteboard/notes", ({ params, body }) => service.whiteboard.addNote(params.id!, obj(body))),
    route("PUT /api/sessions/:id/whiteboard/notes/:noteId", ({ params, body }) => service.whiteboard.editNote(params.id!, params.noteId!, obj(body))),
    route("DELETE /api/sessions/:id/whiteboard/notes/:noteId", ({ params }) => service.whiteboard.removeNote(params.id!, params.noteId!)),
  ];
}
