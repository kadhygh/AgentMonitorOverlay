// Reads each built-in profile's real credential and reports only whether it exists and its length. Never prints keys.
// Then starts a real `codex app-server` with each spec (sandbox CODEX_HOME) and creates a thread without any turn,
// so the config is proven to load. No model calls.
// Usage: npx tsc -b && node packages/host/scripts/smoke-credentials.mjs
import fs from "node:fs";
import { BUILTIN_PROFILES, WindowsCredentialReader, codexServerSpec, codexThreadParams } from "../dist/index.js";
import { RpcClient, sandboxWorkspace, startAppServer } from "../../../spikes/lib.mjs";

const reader = new WindowsCredentialReader();
let ok = true;
for (const profile of BUILTIN_PROFILES) {
  if (!profile.credentialId) {
    console.log(`${profile.id}: no credential needed`);
    continue;
  }
  const secret = reader.read(profile.credentialId);
  console.log(`${profile.id}: credential ${profile.credentialId} ${secret ? `present (length ${secret.length})` : "MISSING"}`);
  if (!secret) ok = false;
  const spec = codexServerSpec(profile, BUILTIN_PROFILES, reader);
  const leaked = spec.configArgs.some((a) => secret && a.includes(secret));
  console.log(`${profile.id}: ${spec.configArgs.length / 2} config overrides, env vars [${Object.keys(spec.env).join(", ")}], key in args: ${leaked}`);
  if (leaked) ok = false;
}

let port = 47915;
for (const profile of BUILTIN_PROFILES) {
  const spec = codexServerSpec(profile, BUILTIN_PROFILES, reader);
  const cwd = sandboxWorkspace("smoke-profiles");
  const codexHome = sandboxWorkspace(`codex-home-smoke-${profile.id}`);
  const server = await startAppServer({ port: port++, cwd, configArgs: spec.configArgs, env: { ...spec.env, CODEX_HOME: codexHome } });
  const client = new RpcClient("smoke", server.url, server.token);
  try {
    await client.connect();
    const st = await client.request("thread/start", { cwd, approvalPolicy: "never", sandbox: "read-only", ...codexThreadParams(profile) });
    console.log(`${profile.id}: real app-server thread/start -> provider ${st.modelProvider}, model ${st.model}`);
    if (profile.provider && st.modelProvider !== profile.provider) ok = false;
  } catch (e) {
    console.log(`${profile.id}: app-server failed: ${e.message} ${server.state.stderr.slice(-400)}`);
    ok = false;
  } finally {
    client.close();
    await server.stop();
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
}
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
