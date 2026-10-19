// A DSH channel's 从网址读取 (2026-10-19): the model names a relay lists. Relays answer the OpenAI-style listing at
// {baseUrl}/v1/models (New API, Sub2API) or, for an address already ending in /v1, at {baseUrl}/models; the key goes
// both ways relays accept it. Only the names come back; nothing of the key is ever in an error.

const trimSlash = (s: string) => s.replace(/\/+$/, "");

export async function listSiteModels(baseUrl: string, key: string, timeoutMs = 10_000): Promise<string[]> {
  const base = trimSlash(baseUrl);
  const urls = /\/v1$/.test(base) ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`];
  let last = "";
  for (const url of urls) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${key}`, "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      last = `连不上 ${url}：${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    if (!res.ok) {
      last = `${url} 回答 ${res.status}`;
      continue;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      last = `${url} 回的不是 JSON`;
      continue;
    }
    const list = (body as { data?: unknown; models?: unknown }).data ?? (body as { models?: unknown }).models;
    if (!Array.isArray(list)) {
      last = `${url} 的回答里没有模型列表`;
      continue;
    }
    const names = list.map((m) => (typeof m === "string" ? m : ((m as { id?: unknown; name?: unknown })?.id ?? (m as { name?: unknown })?.name))).filter((n): n is string => typeof n === "string" && !!n.trim() && !/\s/.test(n));
    return [...new Set(names)];
  }
  throw new Error(last.replaceAll(key, "<key>") || "没读到模型列表");
}
