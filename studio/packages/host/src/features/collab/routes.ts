import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function collabRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/checklist", ({ query }) => service.collab.checklist(query.get("taskId") ?? undefined)),
    route("PATCH", "/api/checklist/:id", ({ params, body }) => service.collab.setChecklistDone(params.id!, obj(body).done)),
    route("GET", "/api/tasks/:id/notes", ({ params }) => service.collab.taskNotes(params.id!)),
    route("POST", "/api/tasks/:id/notes", ({ params, body }) => service.collab.addTaskNote(params.id!, obj(body))),
    route("GET", "/api/mail", ({ query }) =>
      service.collab.mail({
        ...(query.get("sessionId") ? { sessionId: query.get("sessionId")! } : {}),
        ...(query.get("taskId") ? { taskId: query.get("taskId")! } : {}),
        ...(query.get("topicId") ? { topicId: query.get("topicId")! } : {}),
        ...(query.get("forTask") ? { forTaskId: query.get("forTask")! } : {}),
        ...(query.get("forTopic") ? { forTopicId: query.get("forTopic")! } : {}),
        ...(query.get("state") ? { states: query.get("state")!.split(",") as never } : {}),
      }),
    ),
    route("POST", "/api/mail", ({ body }) => service.collab.sendMail(null, obj(body).to, obj(body).text)),
    route("PATCH", "/api/mail/:id", ({ params, body }) => service.collab.updateMail(params.id!, obj(body).state)),
    route("POST", "/api/mail/:id/forward", ({ params, body }) => service.collab.forwardMail(params.id!, obj(body))),
    route("GET", "/api/decisions", ({ query }) => service.collab.decisions(query.get("state") ? { state: query.get("state") as never } : {})),
    route("POST", "/api/decisions/:id/answer", ({ params, body }) => service.collab.answerDecision(params.id!, obj(body).answer)),
  ];
}
