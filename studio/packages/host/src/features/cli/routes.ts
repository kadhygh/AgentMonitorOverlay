import type { HostService } from "../../service.js";
import { route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function cliRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/sessions/:id/commands", ({ params }) => service.cli.listCommands(params.id!)),
    route("POST", "/api/sessions/:id/commands", ({ params, body }) => service.cli.runCommand(params.id!, body)),
    route("POST", "/api/sessions/:id/background/:taskId/stop", async ({ params }) => (await service.cli.stopBackground(params.id!, params.taskId!), { ok: true })),
    route("GET", "/api/sessions/:id/background/:taskId/output", ({ params }) => service.cli.backgroundOutput(params.id!, params.taskId!)),
    route("GET", "/api/settings/chat", () => service.cli.chatSettings()),
    route("PUT", "/api/settings/chat", ({ body }) => service.cli.updateChatSettings(body)),
  ];
}
