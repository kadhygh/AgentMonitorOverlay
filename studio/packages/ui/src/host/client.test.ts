import { afterEach, describe, expect, it, vi } from "vitest";
import { call, HostApiError, request } from "./client.js";

const link = { url: "http://127.0.0.1:1", token: "t" };

afterEach(() => vi.unstubAllGlobals());

function answer(status: number, body: string) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(body, { status, statusText: status === 502 ? "Bad Gateway" : "" }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("request", () => {
  it("sends the token and a JSON body, and gives the JSON back", async () => {
    const fetch = answer(200, JSON.stringify({ ok: 1 }));
    await expect(request(link, "POST", "/api/x", { a: 1 })).resolves.toEqual({ ok: 1 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:1/api/x");
    expect(init.headers).toEqual({ authorization: "Bearer t", "content-type": "application/json" });
    expect(init.body).toBe('{"a":1}');
  });

  it("a Blob goes as it is, with its own type", async () => {
    const fetch = answer(200, "{}");
    const blob = new Blob(["png"], { type: "image/png" });
    await request(link, "POST", "/api/attachments", blob);
    const init = fetch.mock.calls[0]![1];
    expect(init.body).toBe(blob);
    expect((init.headers as Record<string, string>)["content-type"]).toBe("image/png");
  });

  it("the server's error, or the status when the answer is not JSON", async () => {
    answer(409, JSON.stringify({ error: { code: "conflict", message: "已经有了" } }));
    await expect(request(link, "GET", "/api/x")).rejects.toMatchObject({ status: 409, code: "conflict", message: "已经有了" });
    answer(502, "<html>proxy</html>");
    await expect(request(link, "GET", "/api/x")).rejects.toMatchObject({ status: 502, code: "internal", message: "Bad Gateway" });
    answer(200, "not json");
    await expect(request(link, "GET", "/api/x")).rejects.toBeInstanceOf(HostApiError);
  });

  it("call fills the route's :params and query", async () => {
    const fetch = answer(200, "{}");
    await call(link, "GET /api/sessions/:id/items", { id: "s 1" }, undefined, { a: "b" });
    expect(fetch.mock.calls[0]![0]).toBe("http://127.0.0.1:1/api/sessions/s%201/items?a=b");
  });
});
