import { fileURLToPath } from "node:url";

/** The scripted ACP agent (fake-acp-agent.ts) as a command, for DSH sessions in tests: always the built file (tests load testkit from src). */
export function fakeAcpAgent(): { command: string; args: string[] } {
  return { command: process.execPath, args: [fileURLToPath(new URL("../dist/fake-acp-agent.js", import.meta.url))] };
}
