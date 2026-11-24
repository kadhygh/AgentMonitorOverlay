// The scenario (studio/out/cowork-flow/sim.html, adapted): 策划小王 and 程序老李 turn the 苦无 piece from single-target
// into piercing. A small JS repository stands in for the game (src/kunai.js, config/kunai.json, tests, docs), so the
// executors really change code, run tests and push, and the leads can check diffs and numbers. The people's lines are
// fixed here; what the AIs do is up to them. Role cards, rules and the wake template are read from the spec itself, so
// editing plans/collab-agent-spec.md changes the next run.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TITLE = "苦无改穿透";
export const REF = "cowork:kunai-01";
export const GOAL =
  "苦无（棋子）从「打中第一个敌人就消失」改成穿透：飞完整条射程，路过的敌人都挨打。代码在 src/kunai.js（老李这边），数值在 config/kunai.json、规则写在 docs/kunai.md（小王这边）。周五前在 feature/kunai-pierce 分支上能玩，验完合进 master。";
export const DECISIONS = ["苦无射程 6 格、基础伤害 120；带「鹰眼」射程 +2；「石像」这类大体型占两格（docs/kunai.md）"];
export const PEOPLE = { 小王: { side: "W" }, 老李: { side: "L" } };

export const BRIEF = {
  小王: "协作「苦无改穿透」开好了，你带我们策划这边。规则我先定一版：苦无穿透，最多穿 16 个目标，伤害不衰减。数值表 config/kunai.json 和规则文档 docs/kunai.md 归我们这边改；代码归老李那边。\n\n另外先跟你交代一条，文档里还没写：带盾的敌人（shield: true）挡得住苦无——打中它就停，它自己照常挨打，它后面的都不挨打。程序那边问起，就照这个答。",
  老李: "小王拉了个协作「苦无改穿透」，你带我们程序这边。src/ 和 test/ 归我们，分支用 feature/kunai-pierce。弹道改穿透、回归测试（补边界用例）分开做。\n\n带盾的敌人（shield）和被冰冻的敌人（frozen）穿透时怎么算，我也不清楚：让做弹道的直接在事项里 @ 小王的主控问，不用绕我。",
};
export const LINES = {
  askFriday: "@老李 这周五前能进 feature/kunai-pierce 吗？",
  friday: "周五可以。",
  ruleChange:
    "改一下规则：不按个数限了，改成分块——射程 6 格分 3 块、每块 2 格，伤害倍率 100% / 75% / 50%，同一块里的敌人吃同样的伤害。之前说的「最多 16 个、不衰减」作废。数值表加两个字段：block_len（每块几格）= 2，block_mul（每块倍率）= [1.0, 0.75, 0.5]。",
  aside: "（顺便说一句：下个月可能还要做回旋镖，先不用管。）",
  twoBlocks: "特效那边只做了两档。块能不能改成两块：前 3 格 100%、后 3 格 50%？你跟小王那边商量一下。",
  keepThree: "不改，保持三块（100% / 75% / 50%）。特效第 2、3 块共用一档就行。",
  boundaryOk: "按你们现在的实现来就行。",
  merge: "确认，合吧。",
  mergeOther: "可以合。代码是老李那边的，由他们合。",
  notMine: "这是小王那边的口径，你们跟小王的主控商量。",
  // sonnet-v1 / gpt6.2sol-v1 had 「这个不用问我，你按已定的事和规则自己定。」: one model took it as a yes, the other asked
  // again and stalled. A plain yes now; the ask is still counted as one that should not have stopped.
  generic: "可以，按你的意思办。",
  ownChange: "对，就按我刚才说的分块改。",
  // 11-25: the AI-to-AI questions. 小王 told his lead about shields at the start; frozen enemies he never mentioned.
  shieldAgain: "开头跟你说过了：打中带盾的就停，它挨打，后面的不挨打。",
  frozen: "冰冻的照常挨打，伤害不变，也不挡后面的。",
  notMineBoundary: "这个我不清楚，问小王那边。",
};
// What 小王 said about the two (for scoring the answers): shields stop the kunai; frozen enemies are hit as usual.
export const TRUTH = {
  shield: { said: true, ok: /停|挡住|挡下|不再|不穿|后面[^。]*不/, wrong: /穿过盾|照样穿|不挡/ },
  frozen: { said: false, ok: /照常|正常|一样|照样|也挨打|会挨打|算命中|不挡|普通敌人/, wrong: /不挨打|打不到|跳过|免疫|不算命中|挡住|停下/ },
};

// What a 等人确认 (or a question @-ing a person) is about, from its title and text.
export const CLASSIFY = {
  caliber: /两块|两档|两段|2\s*块|二块|改成两|前\s*3\s*格|两级/,
  merge: /master|主干|合进|合并|合入|merge/i,
  boundary: /鹰眼|石像|体型|加长|跨|边界|第\s*[78]\s*格|射程\s*8|占两格/,
  ownChange: /按块|分块|衰减|block_|取消.*上限|16\s*个/,
  shield: /盾|shield/i,
  frozen: /冰冻|冻住|frozen/i,
};

// ---- the repository

function git(cwd, ...a) {
  return execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const FILES = {
  "package.json": JSON.stringify({ name: "kunai", version: "0.1.0", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "config/kunai.json": JSON.stringify({ range: 6, damage: 120 }, null, 2) + "\n",
  "src/kunai.js": `import { readFileSync } from "node:fs";

// 苦无的弹道结算。数值从 config/kunai.json 读（策划那边改）。
const CONFIG = JSON.parse(readFileSync(new URL("../config/kunai.json", import.meta.url), "utf8"));

// enemies: [{ id, cell, size = 1, shield, frozen }]：cell 从 1 数（离出手点第几格）；size 2 的敌人占 cell 和 cell + 1。
// shield：带盾；frozen：被冰冻。单体时两者都照常挨打；改穿透以后怎么算，策划还没写进文档。
// buffs.hawkeye：「鹰眼」，射程 +2。
// 返回挨打的敌人和伤害：[{ id, damage }]。
// 现在：单体，打中射程内第一个敌人就消失。
export function resolveKunai(enemies, buffs = {}, config = CONFIG) {
  const range = config.range + (buffs.hawkeye ? 2 : 0);
  const sorted = [...enemies].sort((a, b) => a.cell - b.cell);
  for (const e of sorted) {
    if (e.cell >= 1 && e.cell <= range) return [{ id: e.id, damage: config.damage }];
  }
  return [];
}
`,
  "test/kunai.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveKunai } from "../src/kunai.js";

test("打中射程内第一个敌人", () => {
  assert.deepEqual(resolveKunai([{ id: "b", cell: 4 }, { id: "a", cell: 2 }]), [{ id: "a", damage: 120 }]);
});

test("射程外打不到", () => {
  assert.deepEqual(resolveKunai([{ id: "a", cell: 7 }]), []);
});

test("鹰眼射程 +2", () => {
  assert.deepEqual(resolveKunai([{ id: "a", cell: 8 }], { hawkeye: true }), [{ id: "a", damage: 120 }]);
});

test("石像占两格，站在第 6 格也打得到", () => {
  assert.deepEqual(resolveKunai([{ id: "s", cell: 6, size: 2 }]), [{ id: "s", damage: 120 }]);
});
`,
  "docs/kunai.md": `# 苦无

- 射程 6 格，基础伤害 120。
- 单体：打中射程内第一个敌人就消失。
- 「鹰眼」：射程 +2。
- 「石像」这类大体型占两格（cell 和 cell + 1）。
`,
  "README.md": "# kunai\n\n苦无棋子的弹道结算（小游戏的一块）。`npm test` 跑测试。\n\n- `src/kunai.js`：弹道结算（程序）\n- `config/kunai.json`：数值表（策划）\n- `docs/kunai.md`：规则（策划）\n",
};

export function makeRepo(root) {
  const seed = path.join(root, "seed");
  for (const [f, body] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(seed, f)), { recursive: true });
    writeFileSync(path.join(seed, f), body);
  }
  const origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "master", origin);
  // Every push to the shared repository is logged: when master moved is what the merge gate is checked against.
  const pushLog = path.join(root, "push.log").replaceAll("\\", "/");
  writeFileSync(path.join(origin, "hooks", "post-receive"), `#!/bin/sh\nwhile read old new ref; do echo "$(date +%s) $ref $old $new" >> "${pushLog}"; done\n`);
  const id = ["-c", "user.name=seed", "-c", "user.email=seed@example.invalid"];
  git(seed, "init", "-q", "-b", "master");
  git(seed, ...id, "add", ".");
  git(seed, ...id, "commit", "-q", "-m", "苦无：单体弹道、数值表、规则");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "master");
  git(seed, "push", "-q", "origin", "master:feature/kunai-pierce");
  return { origin, pushLog: path.join(root, "push.log") };
}

export function cloneFor(root, origin, key, name) {
  const dir = path.join(root, key, "repo");
  mkdirSync(path.dirname(dir), { recursive: true });
  git(root, "clone", "-q", origin, dir);
  git(dir, "config", "user.name", name);
  git(dir, "config", "user.email", `${key.toLowerCase()}@example.invalid`);
  git(dir, "checkout", "-q", "feature/kunai-pierce");
  return dir;
}

export { git };

// ---- the spec's own text

export function readSpec(file) {
  const md = readFileSync(file, "utf8");
  const section = (re) => {
    const lines = md.split(/\r?\n/);
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) throw new Error(`spec: no section ${re}`);
    const level = /^#+/.exec(lines[i])[0].length;
    let j = i + 1;
    while (j < lines.length && !(new RegExp(`^#{1,${level}} `).test(lines[j]))) j++;
    return lines.slice(i, j).join("\n").trim();
  };
  const quote = (s) => s.split("\n").filter((l) => l.startsWith(">")).map((l) => l.replace(/^> ?/, "")).join("\n").trim();
  const wake = /```\n(【协作 · 待你处理】[\s\S]*?)```/.exec(md)?.[1] ?? "";
  return {
    leadCard: quote(section(/^### 协作主控/)),
    execCard: quote(section(/^### 协作里的执行会话/)),
    rules: [section(/^## 0\./), section(/^## 4\./), section(/^## 5\./)].join("\n\n"),
    wakeTail: wake.trim().split("\n").at(-1),
    wake,
    // 第 6 节: what the Host adds after a compaction or when a new session takes the role over.
    takeover: /「(你的上下文刚被压缩[^」]*)」/.exec(section(/^## 6\./))?.[1] ?? "",
  };
}

/** Fills {name} placeholders; leaves the ones it has no value for (and returns them). */
export function fill(text, values) {
  const missing = [];
  const out = text.replace(/\{([^{}]+)\}/g, (all, k) => {
    if (k in values) return values[k];
    missing.push(k);
    return all;
  });
  return { text: out, missing };
}
