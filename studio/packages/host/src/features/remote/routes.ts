import type { HostService } from "../../service.js";
import { obj, route, str, type Route } from "../../http/route.js";
import { HostError } from "../../core/shared.js";

/** The HTTP routes of 远程 (see protocol/src/api.ts for each route's request and response). */
export function remoteRoutes(service: HostService): Route[] {
  const peer = (body: unknown) => {
    const b = obj(body);
    return { account: str(b.account, "account"), device: str(b.device, "device") };
  };
  return [
    route("GET", "/api/remote", () => service.remote.state()),
    route("PUT", "/api/remote/device", ({ body }) => service.remote.rename(str(obj(body).name, "name"))),
    route("POST", "/api/remote/pair", ({ body }) => service.remote.requestPair(str(obj(body).account, "account"))),
    route("POST", "/api/remote/requests/:id/answer", ({ params, body }) => {
      const allow = obj(body).allow;
      if (typeof allow !== "boolean") throw new HostError("bad_request", "allow must be true or false");
      return service.remote.answer(params.id!, allow);
    }),
    route("DELETE", "/api/remote/requests/:id", ({ params }) => service.remote.dismiss(params.id!)),
    route("POST", "/api/remote/unpair", ({ body }) => service.remote.unpair(peer(body))),
    route("POST", "/api/remote/ping", ({ body }) => service.remote.ping(peer(body))),
    route("POST", "/api/remote/reconnect", () => service.remote.reconnect()),
  ];
}
