import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function claudeAccountsRoutes(service: HostService): Route[] {
  const a = service.claudeAccounts;
  return [
    route("GET", "/api/claude-accounts", () => a.state()),
    route("POST", "/api/claude-accounts", ({ body }) => a.add(obj(body).label, obj(body).signIn)),
    route("PUT", "/api/claude-accounts/current", ({ body }) => a.switchTo(obj(body).id)),
    route("POST", "/api/claude-accounts/:id/login", ({ params }) => a.login(params.id!)),
    route("POST", "/api/claude-accounts/:id/login/code", ({ params, body }) => a.loginCode(params.id!, obj(body).code)),
    route("DELETE", "/api/claude-accounts/:id/login", ({ params }) => a.cancelLogin(params.id!)),
    route("POST", "/api/claude-accounts/:id/refresh", ({ params }) => a.refresh(params.id!)),
    route("PATCH", "/api/claude-accounts/:id", ({ params, body }) => a.rename(params.id!, obj(body).label)),
    route("DELETE", "/api/claude-accounts/:id", ({ params }) => a.remove(params.id!)),
  ];
}
