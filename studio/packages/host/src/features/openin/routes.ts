import type { HostService } from "../../service.js";
import { FileReply, route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function openInRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/open-in/apps", () => service.openIn.apps()),
    route("POST", "/api/open-in", ({ body }) => service.openIn.open((body ?? {}) as never)),
    route("GET", "/api/fs/text", ({ query }) => service.openIn.readText(query.get("path"), query.get("workspaceId"))),
    route(
      "GET",
      "/api/fs/raw",
      ({ query }) => {
        const f = service.openIn.image(query.get("path"), query.get("workspaceId"));
        return new FileReply(f.path, f.mime);
      },
      { queryToken: true },
    ),
  ];
}
