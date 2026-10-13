import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function configRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/settings", () => service.config.settings()),
    route("GET", "/api/usage", ({ query }) => service.config.usage(query.get("refresh") === "1")),
    route("PUT", "/api/settings", ({ body }) => service.config.updateSettings(obj(body))),
    route("GET", "/api/profiles/:id/choices", ({ params }) => service.config.choices(params.id!)),
    route("GET", "/api/credentials", () => service.config.credentials()),
    route("PUT", "/api/credentials/:id", ({ params, body }) => service.config.saveCredential(params.id!, obj(body).secret)),
    route("DELETE", "/api/credentials/:id", ({ params }) => service.config.removeCredential(params.id!)),
  ];
}
