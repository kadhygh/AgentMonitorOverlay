import type { HostService } from "../../service.js";
import { FileReply, obj, route, str, type Route } from "../../http/route.js";
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
    route("POST", "/api/remote/pair", ({ body }) => {
      const b = obj(body);
      return service.remote.requestPair(str(b.account, "account"), b.device === undefined || b.device === null || b.device === "" ? undefined : str(b.device, "device"));
    }),
    route("GET", "/api/remote/devices/online", () => service.remote.onlineDevices()),
    route("POST", "/api/remote/requests/:id/answer", ({ params, body }) => {
      const allow = obj(body).allow;
      if (typeof allow !== "boolean") throw new HostError("bad_request", "allow must be true or false");
      return service.remote.answer(params.id!, allow);
    }),
    route("DELETE", "/api/remote/requests/:id", ({ params }) => service.remote.dismiss(params.id!)),
    route("POST", "/api/remote/unpair", ({ body }) => service.remote.unpair(peer(body))),
    route("POST", "/api/remote/ping", ({ body }) => service.remote.ping(peer(body))),
    route("POST", "/api/remote/reconnect", () => service.remote.reconnect()),
    route("POST", "/api/remote/grants", ({ body }) => service.remote.grant(str(obj(body).taskId, "taskId"), peer(body))),
    route("POST", "/api/remote/grants/revoke", ({ body }) => service.remote.revoke(str(obj(body).taskId, "taskId"), peer(body))),
    route("PUT", "/api/remote/allowed", ({ body }) => service.remote.setAllowed(body)),
    route("POST", "/api/remote/files", ({ body }) => {
      const b = obj(body);
      const opt = (v: unknown, name: string) => (v === undefined || v === null || v === "" ? undefined : str(v, name));
      return service.remote.fetchFile(str(b.taskId, "taskId"), str(b.path, "path"), opt(b.cwd, "cwd"), opt(b.fetchId, "fetchId"));
    }),
    route("POST", "/api/remote/asks", ({ body }) => {
      const b = obj(body);
      return service.remote.sendAsk(peer(body), b.title, b.text);
    }),
    route("DELETE", "/api/remote/asks/:id", ({ params }) => service.remote.withdrawAsk(params.id!)),
    route("POST", "/api/remote/task-requests/:id/accept", ({ params, body }) => service.remote.acceptRequest(params.id!, body)),
    route("POST", "/api/remote/task-requests/:id/refuse", ({ params, body }) => service.remote.refuseRequest(params.id!, obj(body).reason)),
    // Step 3: images a remote task's HTML page loads, by their place in the task's folder (the page gets <base> here).
    // An <img> sends no token and <base> drops a query, so the key in the path (random, per task, per Host run) is it.
    {
      method: "GET",
      path: "/api/remote/files/:key/*",
      pattern: /^\/api\/remote\/files\/([\w-]{8,64})\/(.+)$/,
      keys: ["key", "rel"],
      open: true,
      handle: async ({ params }) => {
        const f = await service.remote.serveFile(params.key!, params.rel!);
        return new FileReply(f.path, f.mime, { fresh: true, whole: true });
      },
    },
  ];
}
