// S13-00: what Codex's model/list says about speed tiers (serviceTiers, defaultServiceTier) for each Codex profile.
//   npm run build && node spikes/s13-00-service-tiers.mjs
// model/list only: no model call, no budget. Codex runs with the person's real ~/.codex (where the GPT login is), as
// Studio does, read-only; data and workspaces are sandboxed.
import fs from "node:fs";
import path from "node:path";
import { BUILTIN_PROFILES, CodexServerManager, WindowsCredentialReader } from "../packages/host/dist/index.js";
import { sandboxWorkspace } from "./lib.mjs";

const dataDir = sandboxWorkspace(`s13-00/data-${Date.now()}`);
const manager = new CodexServerManager({ dataDir: path.join(dataDir, "codex"), profiles: BUILTIN_PROFILES, credentials: new WindowsCredentialReader(), cwd: dataDir, portRange: [47950, 47959] });
const out = {};
try {
  for (const p of BUILTIN_PROFILES.filter((x) => x.runtime === "codex")) {
    try {
      const handle = await manager.ensure(p.id);
      const r = await handle.client.request("model/list", { includeHidden: false });
      out[p.id] = r.data.map((m) => ({ model: m.model, isDefault: m.isDefault, serviceTiers: m.serviceTiers, defaultServiceTier: m.defaultServiceTier, additionalSpeedTiers: m.additionalSpeedTiers }));
    } catch (err) {
      out[p.id] = { error: String(err).slice(0, 300) };
    }
    console.log(p.id, JSON.stringify(out[p.id], null, 1));
  }
} finally {
  await manager.stopAll();
  fs.mkdirSync(path.join(import.meta.dirname, "results"), { recursive: true });
  fs.writeFileSync(path.join(import.meta.dirname, "results", "s13-00.json"), JSON.stringify(out, null, 2));
}
