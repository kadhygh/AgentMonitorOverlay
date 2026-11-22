// Lists the model names the DXX site serves (no model turn): which names the sandbox's channels should use.
// The key is old AMO's DXX key, read from the Credential Manager and kept in memory only (spikes/lib.mjs).
import { readAmoCredential } from "../lib.mjs";

const base = "https://gorilla-api.dxxapi.com";
const key = readAmoCredential("dxx");
const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
const data = await res.json().catch(() => ({}));
const ids = (data.data ?? []).map((m) => m.id).sort();
console.log(res.status, ids.length, "models");
console.log(ids.filter((id) => /gpt-?6|sol|deepseek|sonnet|claude/i.test(id)).join("\n"));
