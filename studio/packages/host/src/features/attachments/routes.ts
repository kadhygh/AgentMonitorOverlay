import { MAX_ATTACHMENT_BYTES } from "@amo-studio/protocol";
import type { HostService } from "../../service.js";
import { bytes, FileReply, route, type Route } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function attachmentsRoutes(service: HostService): Route[] {
  return [
    route(
      "POST",
      "/api/attachments",
      ({ body, query }) => service.attachments.save(bytes(body), { name: query.get("name") ?? undefined, mime: query.get("type") ?? undefined }),
      { rawBody: MAX_ATTACHMENT_BYTES },
    ),
    route(
      "GET",
      "/api/attachments/:id",
      ({ params }) => {
        const a = service.attachments.get(params.id!);
        return new FileReply(a.path, a.mime);
      },
      { queryToken: true },
    ),
  ];
}
