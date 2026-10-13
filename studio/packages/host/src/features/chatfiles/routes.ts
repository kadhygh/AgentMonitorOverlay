import type { HostService } from "../../service.js";
import { route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function chatFilesRoutes(service: HostService): Route[] {
  return [route("POST", "/api/fs/exists", ({ body }) => service.chatFiles.exists((body ?? {}) as never))];
}
