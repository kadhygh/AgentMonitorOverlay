import { statSync } from "node:fs";
import type { HostService } from "../../service.js";
import { FileReply, route, type Route } from "../../http/route.js";

/** Images up to this size are sent from memory. */
const WHOLE_MAX = 32 * 1024 * 1024;

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function openInRoutes(service: HostService): Route[] {
  return [
    route("GET /api/open-in/apps", () => service.openIn.apps()),
    route("POST /api/open-in", ({ body }) => service.openIn.open((body ?? {}) as never)),
    route("GET /api/fs/text", ({ query }) => service.openIn.readText(query.get("path"), query.get("workspaceId"))),
    route(
      "GET /api/fs/raw",
      ({ query }) => {
        const f = service.openIn.image(query.get("path"), query.get("workspaceId"));
        // Read whole unless huge: a stream the viewer stopped reading was seen to keep the file open (2026-10-29).
        return new FileReply(f.path, f.mime, { whole: statSync(f.path).size <= WHOLE_MAX });
      },
      { queryToken: true },
    ),
    // 页面旁边的文件 (2026-11-06): the key a page's neighbours are served under, then the files themselves — open, as
    // the remote task's pictures are: a <link> or <img> sends no token and <base> drops a query, so the random key in
    // the path is it. CORS for fonts: the page's frame is sandboxed (origin null), and fonts load in CORS mode.
    route("POST /api/fs/page", ({ body }) => {
      const b = (body ?? {}) as { path?: unknown; workspaceId?: unknown };
      return service.openIn.pageBase(b.path, b.workspaceId);
    }),
    {
      method: "GET",
      path: "/api/fs/page/:key/*",
      pattern: /^\/api\/fs\/page\/([0-9a-f]{32})\/(.+)$/,
      keys: ["key", "rel"],
      open: true,
      handle: ({ params }) => {
        const f = service.openIn.servePage(params.key!, params.rel!);
        return new FileReply(f.path, f.mime, { fresh: true, cors: true, whole: statSync(f.path).size <= WHOLE_MAX });
      },
    },
  ];
}
