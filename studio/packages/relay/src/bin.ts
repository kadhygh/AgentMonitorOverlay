#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RelayClient, RelayClientError, readSettings, relayHome, writeSettings } from "./client.js";
import { createRelayMcp } from "./mcp.js";
import { RELAY_DEFAULT_PORT, type NewRequest } from "./protocol.js";
import { startRelayServer } from "./server.js";
import { RelayStore } from "./store.js";
import { threadAsText, usagePrompt } from "./usage.js";

// amo-relay: the relay service, this machine's identity, and the relay for AIs without MCP (plans/relay.md).
//   serve [--port 47120] [--host 0.0.0.0] [--data <dir>] [--name 策划组]   passphrase: --passphrase or AMO_RELAY_PASSPHRASE
//   join --server <host:port> --name <名字> --passphrase <口令> [--role <负责什么>]
//   whoami | people | prompt | mcp
//   ask --json <file|->   replies [threadId] [--after n]   wait <threadId> [--minutes n]   send <threadId> --body <text>

const USAGE = `amo-relay <command>
  serve    [--port ${RELAY_DEFAULT_PORT}] [--host 0.0.0.0] [--data <dir>] [--name <服务名>] [--passphrase <口令>]
  join     --server <地址:端口> --name <名字> --passphrase <口令> [--role <负责什么>]
  whoami | people | prompt | mcp
  ask      --json <文件|->
  replies  [threadId] [--after n]
  wait     <threadId> [--minutes n]
  send     <threadId> --body <文字>`;

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

const cliCommand = () => `node "${fileURLToPath(import.meta.url)}"`;

function joined(): { client: RelayClient; me: string } {
  const s = readSettings();
  if (!s) throw new Error(`这台机器还没加入中转：先运行 amo-relay join（设置在 ${relayHome()}）`);
  return { client: RelayClient.fromSettings(s), me: s.name };
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
      if (!passphrase) throw new Error("需要团队口令：--passphrase 或环境变量 AMO_RELAY_PASSPHRASE");
      const data = resolve(flags.data ?? join(relayHome(), "server"));
      const store = new RelayStore(join(data, "relay.db"));
      const server = await startRelayServer({ store, passphrase, name: flags.name, host: flags.host, port: flags.port ? Number(flags.port) : RELAY_DEFAULT_PORT });
      out(`AMO 中转服务已启动：端口 ${server.port}，数据在 ${data}`);
      const stop = () => void server.close().then(() => (store.close(), process.exit(0)));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "join": {
      if (!flags.server || !flags.name || !flags.passphrase) throw new Error("用法：amo-relay join --server <地址:端口> --name <名字> --passphrase <口令> [--role <负责什么>]");
      const client = new RelayClient(flags.server);
      await client.health();
      const me = await client.join(flags.name, flags.passphrase, flags.role ?? "");
      writeSettings({ server: client.server, name: me.name, key: me.key });
      out(`已加入 ${client.server}，名字「${me.name}」。设置保存在 ${relayHome()}`);
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
      const res = await client.ask({ ...req, via: { kind: "ai", client: "amo-relay cli" } });
      out(`已发给 ${res.thread.request?.to}。threadId: ${res.thread.id}`);
      return;
    }
    case "replies": {
      const { client, me } = joined();
      if (pos[0]) {
        const { thread, messages } = await client.messages(pos[0], Number(flags.after ?? 0));
        out(threadAsText(thread, messages));
        return;
      }
      for (const t of await client.threads()) {
        if (t.request?.from !== me) continue;
        out(`${t.title} → ${t.request.to} · ${t.request.status === "answered" ? "已回复" : "等回复"} · ${t.id}`);
      }
      return;
    }
    case "wait": {
      if (!pos[0]) throw new Error("用法：amo-relay wait <threadId> [--minutes n]");
      const { client, me } = joined();
      const { messages: all } = await client.messages(pos[0]);
      const after = all.reduce((n, m) => (m.author === me ? Math.max(n, m.seq) : n), 0);
      const minutes = Math.max(0.1, Math.min(Number(flags.minutes ?? 5), 10));
      const got = await client.wait({ threadId: pos[0], after, timeoutMs: minutes * 60_000 });
      if (!got.length) {
        out(`等了 ${minutes} 分钟还没有新回复。`);
        return;
      }
      const { thread } = await client.messages(pos[0], after);
      out(threadAsText(thread, got, all.find((m) => m.kind === "request")));
      return;
    }
    case "send": {
      if (!pos[0] || !flags.body) throw new Error("用法：amo-relay send <threadId> --body <文字>");
      const { client } = joined();
      const res = await client.send(pos[0], { kind: "text", body: flags.body, via: { kind: "ai", client: "amo-relay cli" } });
      out(`已发出（#${res.message.seq}）。`);
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
