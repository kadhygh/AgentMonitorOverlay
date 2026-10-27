#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RelayClient, RelayClientError, clientFromSettings, readSettings, relayHome, writeSettings } from "./client.js";
import { createRelayMcp } from "./mcp.js";
import { RELAY_DEFAULT_PORT, type NewRequest } from "./protocol.js";
import { startRelayServer } from "./server.js";
import { RelayStore } from "./store.js";
import { sessionStateText, threadAsText, usagePrompt } from "./usage.js";

// amo-relay: the relay service, this machine's identity, and the relay for AIs without MCP (plans/relay.md).
//   serve [--port 47120] [--host 0.0.0.0] [--data <dir>] [--public <dir>] [--name 策划组] [--passphrase <邀请口令>]
//         (passphrase also from AMO_RELAY_PASSPHRASE; public = client/ + downloads/, default: next to this file)
//   passwd --data <dir> <名字> <新密码>        on the service machine, while it is stopped or running
//   register --server <host:port> --name <名字> --password <密码> [--role …] [--passphrase …] | login --server … --name … --password …
//   whoami | people | prompt | mcp
//   ask --json <file|->   replies [threadId] [--after n]   wait <threadId> [--minutes n]
//   send <threadId> --body <text> [--then ask|done]   queue   handoff <threadId> --note <text>

const USAGE = `amo-relay <command>
  serve    [--port ${RELAY_DEFAULT_PORT}] [--host 0.0.0.0] [--data <dir>] [--public <dir>] [--name <服务名>] [--passphrase <邀请口令>]
  passwd   [--data <dir>] <名字> <新密码>          （在服务那台机器上重设某人的密码）
  register --server <地址:端口> --name <名字> --password <密码> [--role <负责什么>] [--passphrase <邀请口令>]
  login    --server <地址:端口> --name <名字> --password <密码>
  whoami | people | prompt | mcp
  ask      --json <文件|->
  replies  [threadId] [--after n]
  wait     <threadId> [--minutes n]
  send     <threadId> --body <文字> [--then ask|done]   （ask：继续追问，会话回到对方手里；done：收尾并标记完成）
  queue                                            （待我这边处理的会话）
  handoff  <threadId> --note <文字>                 （交给本人处理）`;

function parse(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string> } {
  const [cmd = "", ...rest] = argv;
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const next = rest[i + 1];
      flags[a.slice(2)] = next !== undefined && !next.startsWith("--") ? (i++, next) : "true";
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

/** What the command line writes counts as the person's AI: it is what agents without MCP use. */
const CLI_VIA = { kind: "ai", client: "amo-relay cli" } as const;

const cliCommand = () => `node "${fileURLToPath(import.meta.url)}"`;

function joined(): { client: RelayClient; me: string } {
  const s = readSettings();
  if (!s) throw new Error(`这台机器还没加入中转：先登录（AMO Relay 客户端，或 amo-relay login；身份在 ${relayHome()}）`);
  return { client: clientFromSettings(s), me: s.name };
}

async function readJsonArg(arg: string): Promise<unknown> {
  if (arg === "-") {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return JSON.parse(readFileSync(arg, "utf8"));
}

async function main(): Promise<void> {
  const { cmd, pos, flags } = parse(process.argv.slice(2));
  const out = (s: string) => process.stdout.write(`${s}\n`);

  switch (cmd) {
    case "serve": {
      // node:sqlite without a flag: Node 22.13+ (the service also runs on a Mac with a plain Node install).
      const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
      if (major < 22 || (major === 22 && minor < 13)) throw new Error(`需要 Node 22.13 或更新（现在是 ${process.versions.node}）`);
      const passphrase = flags.passphrase ?? process.env.AMO_RELAY_PASSPHRASE;
      const data = resolve(flags.data ?? join(relayHome(), "server"));
      const publicDir = resolve(flags.public ?? dirname(fileURLToPath(import.meta.url)));
      const store = new RelayStore(join(data, "relay.db"));
      const server = await startRelayServer({ store, passphrase, publicDir, name: flags.name, host: flags.host, port: flags.port ? Number(flags.port) : RELAY_DEFAULT_PORT });
      out(`AMO 中转服务已启动：端口 ${server.port}；数据 ${data}；客户端 ${publicDir}；${passphrase ? "注册要邀请口令" : "任何人都能注册"}`);
      const stop = () => void server.close().then(() => (store.close(), process.exit(0)));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "passwd": {
      if (pos.length < 2) throw new Error("用法：amo-relay passwd [--data <dir>] <名字> <新密码>");
      const store = new RelayStore(join(resolve(flags.data ?? join(relayHome(), "server")), "relay.db"));
      store.setPassword(pos[0], pos[1]);
      store.close();
      out(`已重设「${pos[0]}」的密码；他之前的登录都失效了。`);
      return;
    }
    case "register":
    case "login": {
      if (!flags.server || !flags.name || !flags.password) throw new Error(`用法：amo-relay ${cmd} --server <地址:端口> --name <名字> --password <密码>`);
      const client = new RelayClient(flags.server);
      await client.health();
      const me = cmd === "register" ? await client.register(flags.name, flags.password, { role: flags.role, passphrase: flags.passphrase }) : await client.login(flags.name, flags.password);
      writeSettings({ server: client.server, name: me.name, key: me.key });
      out(`已${cmd === "register" ? "注册并" : ""}登录 ${client.server}，名字「${me.name}」。身份保存在 ${relayHome()}`);
      return;
    }
    case "whoami": {
      const { client } = joined();
      const me = await client.me();
      out(`${me.name}${me.role ? `（${me.role}）` : ""} @ ${client.server} · ${me.service}`);
      return;
    }
    case "people": {
      const { client, me } = joined();
      for (const m of await client.members()) if (m.name !== me) out(`${m.name}${m.role ? `（${m.role}）` : ""}${m.online ? " · 在线" : ""}`);
      return;
    }
    case "prompt": {
      const { client } = joined();
      const [me, members] = await Promise.all([client.me(), client.members()]);
      out(usagePrompt({ me: me.name, role: me.role, members, cli: cliCommand() }));
      return;
    }
    case "mcp": {
      const server = await createRelayMcp();
      await server.connect(new StdioServerTransport());
      return;
    }
    case "ask": {
      if (!flags.json) throw new Error("用法：amo-relay ask --json <文件|->");
      const { client } = joined();
      const req = (await readJsonArg(flags.json)) as NewRequest;
      const res = await client.ask({ ...req, via: CLI_VIA });
      out(`已发给 ${res.thread.request?.to}。threadId: ${res.thread.id}`);
      return;
    }
    case "replies": {
      const { client, me } = joined();
      if (pos[0]) {
        const { thread, messages } = await client.messages(pos[0], Number(flags.after ?? 0), { ai: true });
        out(threadAsText(thread, messages));
        return;
      }
      for (const t of await client.threads()) {
        if (!t.request || (t.request.from !== me && t.request.to !== me)) continue;
        out(`${t.title} · ${t.request.from} → ${t.request.to} · ${sessionStateText(t.request)} · ${t.id}`);
      }
      return;
    }
    case "wait": {
      if (!pos[0]) throw new Error("用法：amo-relay wait <threadId> [--minutes n]");
      const { client, me } = joined();
      const { messages: all } = await client.messages(pos[0]);
      const after = all.reduce((n, m) => (m.author === me ? Math.max(n, m.seq) : n), 0);
      const minutes = Math.max(0.1, Math.min(Number(flags.minutes ?? 5), 10));
      const got = await client.wait({ threadId: pos[0], after, timeoutMs: minutes * 60_000, ai: true });
      if (!got.length) {
        out(`等了 ${minutes} 分钟还没有新回复。`);
        return;
      }
      const { thread } = await client.messages(pos[0], after);
      out(threadAsText(thread, got, all.find((m) => m.kind === "request")));
      return;
    }
    case "send": {
      const then = flags.then ?? "note";
      if (!pos[0] || (!flags.body && then !== "done") || !["ask", "done", "note"].includes(then)) throw new Error("用法：amo-relay send <threadId> --body <文字> [--then ask|done]");
      const { client } = joined();
      if (flags.body) {
        const res = await client.send(pos[0], { kind: "text", body: flags.body, pass: then === "ask", via: CLI_VIA });
        out(then === "ask" ? `已追问（#${res.message.seq}），会话回到对方手里。` : `已发出（#${res.message.seq}）。`);
      }
      if (then === "done") {
        await client.session(pos[0], "done", { via: CLI_VIA });
        out("已标记完成。");
      }
      return;
    }
    case "queue": {
      const { client, me } = joined();
      const live = (await client.threads()).filter((t) => t.request && t.request.state !== "done" && t.request.waitingOn === me);
      if (!live.length) out("没有待处理的会话。");
      for (const t of live) {
        const r = t.request!;
        const what = r.from === me ? (r.handler === "ai" ? "返回给我，等 AI 接着处理" : "已由本人接手，不要动") : "发给我，等我本人回复";
        out(`${t.title} · ${r.from} → ${r.to} · ${what} · ${t.id}`);
      }
      return;
    }
    case "handoff": {
      if (!pos[0] || !flags.note) throw new Error("用法：amo-relay handoff <threadId> --note <文字>");
      const { client } = joined();
      await client.session(pos[0], "handoff", { note: flags.note, via: CLI_VIA });
      out("已交给本人。");
      return;
    }
    default:
      out(USAGE);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof RelayClientError || err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
