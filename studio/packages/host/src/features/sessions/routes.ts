import type { HostService } from "../../service.js";
import { route, type Route, str, obj } from "../../http/route.js";
import { HostError } from "../../core/shared.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function sessionsRoutes(service: HostService): Route[] {
  return [
    route("PATCH", "/api/sessions/:id/options", ({ params, body }) => service.sessions.updateSessionOptions(params.id!, body)),
    // 远程副本 (remoteCopy, http/route.ts): renamed on A (RemoteCopies.renameSession, 2026-10-30); its options are A's.
    route("PATCH", "/api/sessions/:id", ({ params, body }) => service.sessions.renameSession(params.id!, obj(body).title), { remoteCopy: "forward" }),
    route("GET", "/api/sessions/:id/items", ({ params, query }) => service.sessions.items(params.id!, Number(query.get("after") ?? 0) || 0, Number(query.get("tail") ?? 0) || 0)),
    route("POST", "/api/sessions/:id/messages", ({ params, body }) => {
      const b = obj(body);
      const attachments = b.attachments ?? [];
      if (!Array.isArray(attachments) || attachments.some((a) => typeof a !== "string")) throw new HostError("bad_request", "attachments must be a list of ids");
      const annotations = b.annotations ?? [];
      if (!Array.isArray(annotations) || annotations.some((a) => typeof a !== "string")) throw new HostError("bad_request", "annotations must be a list of ids");
      if (b.now !== undefined && typeof b.now !== "boolean") throw new HostError("bad_request", "now must be true or false");
      return service.sessions.sendMessage(params.id!, b.text === undefined && (attachments.length || annotations.length) ? "" : str(b.text, "text"), attachments as string[], annotations as string[], { now: b.now === true });
    }, { remoteCopy: "forward" }),
    // 立即发送 / 重新发送 (2026-11-02): on a copy, done on A, like a message.
    route("POST", "/api/sessions/:id/items/:itemId/send-now", async ({ params }) => (await service.sessions.sendNow(params.id!, params.itemId!), { ok: true }), { remoteCopy: "forward" }),
    route("POST", "/api/sessions/:id/items/:itemId/resend", ({ params }) => service.sessions.resend(params.id!, params.itemId!), { remoteCopy: "forward" }),
    route("POST", "/api/sessions/:id/wake", ({ params, body }) => service.sessions.setWakeChoice(params.id!, body)),
    route("POST", "/api/sessions/:id/interrupt", async ({ params }) => (await service.sessions.interrupt(params.id!), { ok: true }), { remoteCopy: "forward" }),
    route("POST", "/api/sessions/:id/fork", ({ params, body }) => {
      const p = obj(body).profileId;
      return service.sessions.fork(params.id!, typeof p === "string" ? p : undefined);
    }),
    // 归档 / 恢复 one session of a copy (2026-10-30): done on A (RemoteCopies.archive); archiving the task deletes the copy.
    route("POST", "/api/sessions/:id/archive", ({ params }) => service.sessions.archive(params.id!), { remoteCopy: "forward" }),
    route("POST", "/api/sessions/:id/unarchive", ({ params }) => service.sessions.unarchive(params.id!), { remoteCopy: "forward" }),
    route("POST", "/api/sessions/:id/terminal", ({ params, body }) => service.sessions.terminal(params.id!, obj(body).launch === true)),
    route("POST", "/api/sessions/:id/reclaim", ({ params }) => service.sessions.reclaim(params.id!)),
    route("POST", "/api/sessions/:id/questions/:itemId/answer", async ({ params, body }) => (await service.sessions.answerQuestion(params.id!, params.itemId!, body), { ok: true }), { remoteCopy: "forward" }),
    route("POST", "/api/approvals/:approvalId", async ({ params, body }) => {
      const b = obj(body);
      await service.sessions.respondApproval(str(b.sessionId, "sessionId"), params.approvalId!, b.decision as never);
      return { ok: true };
    }),
  ];
}
