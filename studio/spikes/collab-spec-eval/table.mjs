// Every scored run side by side (the report's tables): the seven points, then tokens per run.
//   node spikes/collab-spec-eval/table.mjs out/collab-spec-eval/<run> …
import { readFileSync } from "node:fs";
import path from "node:path";
import { summaryRow } from "./score.mjs";

const runs = process.argv.slice(2).map((d) => JSON.parse(readFileSync(path.join(d, "score.json"), "utf8")));
const tag = (s) => s.run.replace(/^\d{4}-\d\d-\d\dT[\d-]+-/, "");
const rows = runs.map(summaryRow);
const keys = Object.keys(rows[0]).filter((k) => !k.startsWith("7"));
const out = [`| 项 | ${runs.map(tag).join(" | ")} |`, `|---|${runs.map(() => "---").join("|")}|`];
for (const k of keys) out.push(`| ${k} | ${rows.map((r) => r[k].replace(/\|/g, "/")).join(" | ")} |`);
out.push(`| 时长 / 轮 | ${runs.map((s) => `${s.minutes} 分 / ${s.turns} 轮`).join(" | ")} |`);
out.push(`| 主控改了对方的事项（只记不拒） | ${runs.map((s) => s.leadViol.length).join(" | ")} |`);
out.push("", "| 运行 | 角色 | 轮 | 输入（合计） | 其中缓存 | 输出（合计） | 每轮输入 | 每轮输出 |", "|---|---|---|---|---|---|---|---|");
for (const s of runs) {
  let ti = 0, to = 0, tn = 0, tc = 0;
  for (const [k, v] of Object.entries(s.p7)) {
    ti += v.input; to += v.output; tn += v.turns; tc += v.cached || 0;
    out.push(`| ${tag(s)} | ${k} | ${v.turns} | ${v.input} | ${v.cached || "—"} | ${v.output || "—"} | ${Math.round(v.input / v.turns / 1000)}k | ${v.output ? (v.output / v.turns / 1000).toFixed(1) + "k" : "—"} |`);
  }
  out.push(`| **${tag(s)}** | **合计** | ${tn} | ${ti} | ${tc || "—"} | ${to || "—"} | ${Math.round(ti / tn / 1000)}k | ${to ? (to / tn / 1000).toFixed(1) + "k" : "—"} |`);
}
console.log(out.join("\n"));
