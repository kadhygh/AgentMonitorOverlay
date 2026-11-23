import type { HostService } from "../../service.js";
import { route, type Route } from "../../http/route.js";

/** 转到我的会话 through a 中转 client that only knows POST /api/ui/open (2026-11-23): `cowork-to-<threadId>`. */
const HANDOFF_BRIDGE = "cowork-to-";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function teamRelayRoutes(service: HostService): Route[] {
  const cowork = service.teamRelay.cowork;
  return [
    route("GET /api/teamrelay/sends", () => service.teamRelay.sends()),
    route("POST /api/teamrelay/sends/:id/send", ({ params }) => service.teamRelay.send(params.id!)),
    route("POST /api/teamrelay/sends/:id/dismiss", ({ params }) => service.teamRelay.dismiss(params.id!)),
    route("GET /api/teamrelay/threads", () => service.teamRelay.threads()),
    route("POST /api/ui/open", async ({ body }) => {
      const sessionId = (body as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId === "string" && sessionId.startsWith(HANDOFF_BRIDGE)) {
        await cowork.handoff(sessionId.slice(HANDOFF_BRIDGE.length));
        return { taskId: "", sessionId: "" };
      }
      return service.teamRelay.openInUi(sessionId);
    }),
    // 协作 (2026-11-23, cowork.ts).
    route("GET /api/cowork/joined", () => cowork.joined()),
    route("GET /api/cowork/coworks", () => cowork.coworks()),
    route("POST /api/cowork/join", ({ body }) => {
      const b = (body ?? {}) as { sessionId?: unknown; coworkId?: unknown; label?: unknown };
      return cowork.join(b.sessionId, b.coworkId, b.label);
    }),
    route("POST /api/cowork/leave", ({ body }) => {
      const b = (body ?? {}) as { sessionId?: unknown; coworkId?: unknown };
      return cowork.leave(b.sessionId, b.coworkId);
    }),
    route("POST /api/sessions/:id/composer", ({ params, body }) => (cowork.composerSaid(params.id!, (body as { hasText?: unknown } | null)?.hasText === true), { ok: true as const })),
    route("POST /api/cowork/handoff", ({ body }) => cowork.handoff((body as { threadId?: unknown } | null)?.threadId)),
    route("GET /api/cowork/handoffs", () => cowork.handoffs()),
    route("POST /api/cowork/handoff/accept", ({ body }) => cowork.acceptHandoff((body ?? {}) as never)),
    route("POST /api/cowork/handoff/dismiss", ({ body }) => cowork.dismissHandoff((body as { threadId?: unknown } | null)?.threadId)),
    // 复制会话引用 and the 协作 line opening the 中转 client (2026-11-23).
    route("GET /api/sessions/:id/ref", ({ params }) => cowork.sessionRef(params.id)),
    route("POST /api/cowork/open-in-relay", ({ body }) => cowork.openInRelay((body as { target?: unknown } | null)?.target)),
  ];
}
