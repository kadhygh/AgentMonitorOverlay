// S9-05: when does Codex route an approval to its review agent ("Approve for me") instead of the client? (mock, no budget)
//   npm run build && node spikes/s9-05-auto-review-routing.mjs
// S9-04 showed that approvalsReviewer "auto_review" with approvalPolicy "untrusted" still sent the command approval to
// the client. Variants: approval policy × the guardian_approval feature flag. The mock model cannot answer as a
// reviewer, so only the routing is observed (review notifications vs. a request to the client).
import fs from "node:fs";
import path from "node:path";
import { codexServerSpec } from "../packages/host/dist/index.js";
import { mockCodexProvider, startMockModel } from "../packages/testkit/dist/index.js";
import { RpcClient, sandboxWorkspace, startAppServer } from "./lib.mjs";

const cwd = sandboxWorkspace("s9-05/workspace");
const mock = await startMockModel();
const profile = { id: "codex-mock", label: "Mock", runtime: "codex", provider: "amo-mock", model: "mock-model", credentialId: "mock" };
const spec = codexServerSpec(profile, [profile], { read: () => "mock-key" }, { providers: { "amo-mock": mockCodexProvider(mock.baseUrl) } });
const variants = [
  { approvalPolicy: "untrusted", feature: false },
  { approvalPolicy: "untrusted", feature: true },
  { approvalPolicy: "on-request", feature: true, sandbox: "read-only" },
  { approvalPolicy: "on-request", feature: false, sandbox: "read-only" },
  // The person's machine: the unelevated Windows sandbox, where sandboxed commands fail to start.
  { approvalPolicy: "on-request", feature: false, sandbox: "workspace-write", windowsSandbox: "unelevated" },
];
const out = [];
let port = 47916;
for (const v of variants) {
  const codexHome = sandboxWorkspace(`s9-05/codex-home-${out.length}`);
  const extra = [...(v.feature ? ["-c", "features.guardian_approval=true"] : []), ...(v.windowsSandbox ? ["-c", `windows.sandbox=${JSON.stringify(v.windowsSandbox)}`] : [])];
  const server = await startAppServer({ port: port++, cwd, configArgs: [...spec.configArgs, ...extra], env: { ...spec.env, CODEX_HOME: codexHome } });
  const seen = { requests: [], reviews: [] };
  const client = new RpcClient("s9-05", server.url, server.token, {
    onServerRequest: (e, c) => {
      seen.requests.push(e.method);
      c.respond(e.id, { decision: "decline" });
    },
  });
  try {
    await client.connect();
    const st = await client.request("thread/start", { cwd, approvalPolicy: v.approvalPolicy, approvalsReviewer: "auto_review", sandbox: v.sandbox ?? "danger-full-access" });
    await client.request("turn/start", { threadId: st.thread.id, input: [{ type: "text", text: "[[shell: cmd /c echo hi]]", text_elements: [] }] });
    const t0 = Date.now();
    while (Date.now() - t0 < 25_000) {
      const done = client.events.some((e) => e.method === "turn/completed");
      if (done) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    for (const e of client.events) if (String(e.method).includes("autoApprovalReview") || String(e.method).includes("strictReview")) seen.reviews.push(`${e.method}:${e.params?.review?.status ?? ""}`);
    const cmd = [...client.events].reverse().find((e) => e.method === "item/completed" && e.params?.item?.type === "commandExecution")?.params.item;
    out.push({ ...v, ...seen, completed: client.events.some((e) => e.method === "turn/completed"), command: cmd ? { status: cmd.status, exitCode: cmd.exitCode, out: String(cmd.aggregatedOutput ?? "").slice(0, 120) } : null });
  } catch (err) {
    out.push({ ...v, error: String(err).slice(0, 300) });
  } finally {
    client.close();
    await server.stop();
  }
  console.log(JSON.stringify(out.at(-1)));
}
await mock.close();
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "results", "s9-05-auto-review-routing.json"), JSON.stringify(out, null, 2));
