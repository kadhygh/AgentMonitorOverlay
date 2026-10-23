import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function gitReviewRoutes(service: HostService): Route[] {
  return [
    route("GET", "/api/workspaces/:id/git/status", ({ params }) => service.gitReview.status(params.id!)),
    route("GET", "/api/workspaces/:id/git/changes", ({ params, query }) => service.gitReview.changes(params.id!, query.get("range"), query.get("base"), query.get("label"))),
    route("GET", "/api/workspaces/:id/git/diff", ({ params, query }) =>
      service.gitReview.diff(params.id!, query.get("range"), query.get("path"), query.get("oldPath"), { base: query.get("base"), untracked: query.get("untracked") }),
    ),
    route("GET", "/api/workspaces/:id/git/log", ({ params, query }) => service.gitReview.log(params.id!, query.get("limit"))),
    route("GET", "/api/workspaces/:id/git/commit", ({ params, query }) => service.gitReview.commit(params.id!, query.get("sha"), query.get("base"))),
    route("POST", "/api/review/open", ({ body }) => service.gitReview.openReview(obj(body) as never)),
    route("GET", "/api/workspaces/:id/git/commit-diff", ({ params, query }) =>
      service.gitReview.commitDiff(params.id!, query.get("sha"), query.get("base"), query.get("path"), query.get("oldPath")),
    ),
    route("GET", "/api/workspaces/:id/review-comments", ({ params }) => service.gitReview.comments(params.id!)),
    route("POST", "/api/workspaces/:id/review-comments/copy", ({ params, body }) => service.gitReview.copy(params.id!, obj(body).ids)),
    route("POST", "/api/workspaces/:id/review-comments/send", ({ params, body }) => service.gitReview.send(params.id!, obj(body).sessionId, obj(body).ids)),
    route("POST", "/api/workspaces/:id/review-comments", ({ params, body }) => service.gitReview.addComment(params.id!, obj(body) as never)),
    route("PATCH", "/api/review-comments/:id", ({ params, body }) => service.gitReview.updateComment(params.id!, obj(body).note)),
    route("DELETE", "/api/review-comments/:id", ({ params }) => (service.gitReview.deleteComment(params.id!), { ok: true })),
  ];
}
