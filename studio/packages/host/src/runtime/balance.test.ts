import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askBalance, pick } from "./balance.js";

/** A fetch that answers from a table and records what was asked. */
function fake(table: Record<string, unknown>, status = 200) {
  const asked: Array<{ url: string; headers: Record<string, string>; redirect?: RequestRedirect }> = [];
  const f = (async (url: URL, init: RequestInit) => {
    asked.push({ url: String(url), headers: init.headers as Record<string, string>, ...(init.redirect ? { redirect: init.redirect } : {}) });
    const hit = Object.entries(table).find(([k]) => String(url).startsWith(k));
    return new Response(hit ? JSON.stringify(hit[1]) : "nope", { status: hit ? status : 404 });
  }) as unknown as typeof fetch;
  return { f, asked };
}

describe("askBalance", () => {
  it("通用: {base}/user/balance with the key", async () => {
    const { f, asked } = fake({ "https://r.example/v1/user/balance": { balance: "3.456" } });
    const b = await askBalance({ profileId: "p", baseUrl: "https://r.example/v1/", config: { template: "general" }, key: "sk", fetch: f });
    expect(b).toMatchObject({ ok: true, remaining: 3.46, unit: "USD" });
    expect(asked[0]!.headers.Authorization).toBe("Bearer sk");
  });

  it("New API: the panel's /api/user/self with the access token and user id, quotas ÷ 500000", async () => {
    const { f, asked } = fake({ "https://panel.example/api/user/self": { success: true, data: { quota: 5_000_000, used_quota: 2_500_000, group: "vip" } } });
    const b = await askBalance({ profileId: "p", baseUrl: "https://panel.example/v1", config: { template: "newapi", userId: "42" }, key: "sk", accessToken: "tok", fetch: f });
    expect(b).toMatchObject({ ok: true, remaining: 10, used: 5, total: 15, planName: "vip" });
    expect(asked[0]!.headers).toMatchObject({ Authorization: "Bearer tok", "New-Api-User": "42" });
  });

  it("Sub2API, OpenAI billing and DeepSeek", async () => {
    const sub = fake({ "https://s.example/v1/usage": { remaining: 7, quota: { used: 3, limit: 10 }, planName: "月卡" } });
    expect(await askBalance({ profileId: "p", baseUrl: "https://s.example/v1", config: { template: "sub2api" }, key: "k", fetch: sub.f })).toMatchObject({ ok: true, remaining: 7, used: 3, total: 10, planName: "月卡" });
    const oa = fake({ "https://o.example/v1/dashboard/billing/subscription": { hard_limit_usd: 20 }, "https://o.example/v1/dashboard/billing/usage": { total_usage: 525 } });
    expect(await askBalance({ profileId: "p", baseUrl: "https://o.example", config: { template: "openai" }, key: "k", fetch: oa.f })).toMatchObject({ ok: true, remaining: 14.75, used: 5.25, total: 20 });
    const ds = fake({ "https://api.deepseek.com/user/balance": { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "88.10" }] } });
    expect(await askBalance({ profileId: "p", baseUrl: "", config: { template: "deepseek" }, key: "k", fetch: ds.f })).toMatchObject({ ok: true, remaining: 88.1, unit: "CNY" });
  });

  it("自定义: placeholders, JSON paths and a divisor", async () => {
    const { f, asked } = fake({ "https://c.example/q": { data: { left: 1500, items: [{ used: 500 }] } } });
    const b = await askBalance({ profileId: "p", baseUrl: "https://c.example", config: { template: "custom", url: "{{baseUrl}}/q?k={{apiKey}}", remainingPath: "data.left", usedPath: "data.items.0.used", divisor: 100, unit: "元" }, key: "a b", fetch: f });
    expect(b).toMatchObject({ ok: true, remaining: 15, used: 5, unit: "元" });
    expect(asked[0]!.url).toBe("https://c.example/q?k=a%20b");
    expect(pick({ a: [{ b: 1 }] }, "a.0.b")).toBe(1);
  });

  it("says why it failed, never with the key in it", async () => {
    const { f } = fake({ "https://r.example/user/balance": {} }, 401);
    const b = await askBalance({ profileId: "p", baseUrl: "https://r.example", config: { template: "general" }, key: "sk-secret", fetch: f });
    expect(b.ok).toBe(false);
    expect(b.message).toContain("Key 或令牌不对");
    expect(b.message).not.toContain("sk-secret");
    expect((await askBalance({ profileId: "p", baseUrl: "https://r.example", config: { template: "general" }, key: null, fetch: f })).message).toContain("还没有保存");
    const missing = await askBalance({ profileId: "p", baseUrl: "https://none.example", config: { template: "sub2api" }, key: "k", fetch: f });
    expect(missing.message).toContain("没有这个查询接口");
  });

  it("DeepSeek 账号: Platform's account summary with the DSH desktop app's sign-in, only to Platform (2026-11-09)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amo-ds-account-"));
    try {
      const file = join(dir, ".credentials.yaml");
      const record = (issuer: string) =>
        ["records:", "  deepseek-account-platform/default:", "    kind: grant", "    payload:", "      version: 1", '      token: "tok-secret-123"', `      issuer: ${issuer}`, ""].join("\n");
      writeFileSync(file, record("https://platform.deepseek.com"));
      const url = "https://platform.deepseek.com/api/v0/users/get_user_summary";
      const summary = {
        code: 0,
        data: { biz_code: 0, biz_data: { normal_wallets: [{ currency: "CNY", balance: "57.7110685200000000" }], bonus_wallets: [{ currency: "CNY", balance: "2.5" }, { currency: "USD", balance: "1" }], total_costs: [] } },
      };
      const ok = fake({ [url]: summary });
      const b = await askBalance({ profileId: "dsh-deepseek", baseUrl: "", config: { template: "deepseek-account" }, key: null, accountFile: file, fetch: ok.f });
      expect(b).toMatchObject({ ok: true, remaining: 60.21, unit: "CNY", planName: "含赠送 2.5，另有 1 USD" });
      expect(ok.asked).toEqual([{ url, headers: expect.objectContaining({ "x-dsh-auth-token": "tok-secret-123" }), redirect: "error" }]);

      const expired = await askBalance({ profileId: "p", baseUrl: "", config: { template: "deepseek-account" }, key: null, accountFile: file, fetch: fake({ [url]: {} }, 401).f });
      expect(expired.message).toContain("登录过期");
      expect(expired.message).not.toContain("tok-secret");
      const refused = await askBalance({ profileId: "p", baseUrl: "", config: { template: "deepseek-account" }, key: null, accountFile: file, fetch: fake({ [url]: { code: 0, data: { biz_code: 40003, biz_msg: "invalid" } } }).f });
      expect(refused.message).toContain("DeepSeek 没有返回余额");

      // Signed in elsewhere: the token goes nowhere.
      writeFileSync(file, record("https://other.example"));
      const other = fake({ [url]: summary });
      expect((await askBalance({ profileId: "p", baseUrl: "", config: { template: "deepseek-account" }, key: null, accountFile: file, fetch: other.f })).message).toContain("不把它的登录发到别处");
      expect(other.asked).toEqual([]);
      writeFileSync(file, "records: {}\n");
      expect((await askBalance({ profileId: "p", baseUrl: "", config: { template: "deepseek-account" }, key: null, accountFile: file, fetch: other.f })).message).toContain("还没有登录");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
