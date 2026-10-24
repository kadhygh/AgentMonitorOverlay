import type { ChannelInput } from "@amo-studio/protocol";
import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function channelsRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/channels", () => service.channels.list()),
    route("GET", "/api/claude-code", () => service.channels.claudeCode()),
    route("POST", "/api/claude-code/check", () => service.channels.checkClaudeCode()),
    route("POST", "/api/channels", ({ body }) => service.channels.create(obj(body) as ChannelInput)),
    route("POST", "/api/channels/balance-test", ({ body }) => service.channels.testBalance(obj(body))),
    route("POST", "/api/channels/models-test", ({ body }) => service.channels.siteModels(obj(body))),
    route("PATCH", "/api/channels/:id", ({ params, body }) => service.channels.update(params.id!, obj(body) as ChannelInput)),
    route("DELETE", "/api/channels/:id", ({ params }) => service.channels.remove(params.id!)),
    route("PUT", "/api/profiles/:id/hidden", ({ params, body }) => service.channels.setHidden(params.id!, obj(body).hidden)),
    route("GET", "/api/profiles/:id/balance", ({ params, query }) => service.channels.balance(params.id!, query.get("refresh") === "1")),
  ];
}
