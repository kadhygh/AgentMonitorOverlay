const fs = require("fs");
const path = require("path");
const { httpError } = require("../lib/http");
const { readJsonFileStrict, writeTextFile } = require("../lib/filesystem");

const CODEX_HOOK_EVENTS = Object.freeze([
  "Stop",
  "UserPromptSubmit",
  "PermissionRequest",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
]);
function codexReplyHookScript(options = {}) {
  const deploymentVersion = options.deploymentVersion ?? 2;
  const hookProtocolVersion = options.hookProtocolVersion ?? 2;
  return [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "",
    "const __filename = fileURLToPath(import.meta.url);",
    "const __dirname = path.dirname(__filename);",
    "const amoRoot = path.resolve(__dirname, '..');",
    "const projectRoot = path.resolve(amoRoot, '..');",
    "const adapterConfigFile = path.join(amoRoot, 'adapters', 'codex-cli.json');",
    "const cacheRoot = path.join(projectRoot, '.codex', 'cache');",
    "const assistantArchiveRoot = path.join(cacheRoot, 'assistant-turns');",
    "const userArchiveRoot = path.join(cacheRoot, 'user-prompts');",
    "const latestAssistantFile = path.join(cacheRoot, 'latest-assistant-message.md');",
    "const latestAssistantJsonFile = path.join(cacheRoot, 'latest-assistant-message.json');",
    "const latestUserPromptFile = path.join(cacheRoot, 'latest-user-prompt.md');",
    "const latestUserPromptJsonFile = path.join(cacheRoot, 'latest-user-prompt.json');",
    "const errorLogFile = path.join(cacheRoot, 'assistant-turn-errors.log');",
    `const amoDeploymentVersion = ${JSON.stringify(deploymentVersion)};`,
    `const amoHookProtocolVersion = ${JSON.stringify(hookProtocolVersion)};`,
    `const amoHookEvents = ${JSON.stringify(CODEX_HOOK_EVENTS)};`,
    "",
    "try {",
    "  const rawInput = await readStdin();",
    "  const inputText = rawInput.replace(/^\\uFEFF/u, '');",
    "  const payload = inputText.trim().length > 0 ? JSON.parse(inputText) : {};",
    "  const eventName = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'unknown';",
    "  const lowerEventName = eventName.toLowerCase();",
    "  const isPromptEvent = lowerEventName === 'userpromptsubmit';",
    "  const isStopEvent = lowerEventName === 'stop';",
    "  const assistantMessage = normalizeMessage(payload.last_assistant_message);",
    "  const isReplyEvent = isStopEvent && Boolean(assistantMessage);",
    "  const isEventOnly = !isPromptEvent && !isReplyEvent;",
    "  const message = normalizeMessage(",
    "    isPromptEvent",
    "      ? payload.prompt ?? payload.message",
    "      : isReplyEvent",
    "        ? assistantMessage",
    "        : fallbackEventMessage(payload, eventName)",
    "  );",
    "",
    "  if (message || isEventOnly) {",
    "    const capturedAt = new Date().toISOString();",
    "    const record = {",
    "      schemaVersion: 1,",
    "      amoDeploymentVersion,",
    "      amoHookProtocolVersion,",
    "      amoHookEvents,",
    "      tool: 'codex',",
    "      role: isPromptEvent ? 'user' : isReplyEvent ? 'assistant' : 'event',",
    "      source: isPromptEvent ? 'codex-user-prompt-hook' : isReplyEvent ? 'codex-stop-hook' : 'codex-event-hook',",
    "      capturedAt,",
    "      sessionId: typeof payload.session_id === 'string' ? payload.session_id : 'unknown-session',",
    "      turnId: typeof payload.turn_id === 'string' ? payload.turn_id : 'unknown-turn',",
    "      model: typeof payload.model === 'string' ? payload.model : null,",
    "      hookEventName: eventName,",
    "      cwd: typeof payload.cwd === 'string' ? payload.cwd : projectRoot,",
    "      transcriptPath: typeof payload.transcript_path === 'string' ? payload.transcript_path : null,",
    "      stopHookActive: Boolean(payload.stop_hook_active),",
    "      state: inferHookState(payload, eventName, isPromptEvent, isReplyEvent, isStopEvent),",
    "      message,",
    "    };",
    "",
    "    const bridgeResult = await postToBridge(record, isPromptEvent, isEventOnly);",
    "    if (!isEventOnly) {",
    "      if (bridgeResult.debugEnabled || !bridgeResult.ok) {",
    "        await writeCacheRecord(record, isPromptEvent);",
    "      } else {",
    "        await cleanupCacheRecord(record, isPromptEvent);",
    "      }",
    "    }",
    "  }",
    "",
    "  process.stdout.write('{\"continue\":true}\\n');",
    "} catch (error) {",
    "  await fs.mkdir(cacheRoot, { recursive: true });",
    "  const errorText = error instanceof Error ? `${error.stack ?? error.message}` : String(error);",
    "  await fs.appendFile(errorLogFile, `[${new Date().toISOString()}] ${errorText}\\n`, 'utf8');",
    "  process.stdout.write('{\"continue\":true}\\n');",
    "}",
    "",
    "function readStdin() {",
    "  return new Promise((resolve, reject) => {",
    "    let data = '';",
    "    process.stdin.setEncoding('utf8');",
    "    process.stdin.on('data', (chunk) => { data += chunk; });",
    "    process.stdin.on('end', () => resolve(data));",
    "    process.stdin.on('error', reject);",
    "  });",
    "}",
    "",
    "function cachePathsFor(record, isPromptEvent) {",
    "  const archiveRoot = isPromptEvent ? userArchiveRoot : assistantArchiveRoot;",
    "  const latestFile = isPromptEvent ? latestUserPromptFile : latestAssistantFile;",
    "  const latestJsonFile = isPromptEvent ? latestUserPromptJsonFile : latestAssistantJsonFile;",
    "  const archiveStem = `${fileSafeTimestamp(record.capturedAt)}-${sanitizeFilePart(record.turnId)}`;",
    "  return {",
    "    archiveRoot,",
    "    latestFile,",
    "    latestJsonFile,",
    "    archiveMarkdownFile: path.join(archiveRoot, `${archiveStem}.md`),",
    "    archiveJsonFile: path.join(archiveRoot, `${archiveStem}.json`),",
    "  };",
    "}",
    "",
    "async function writeCacheRecord(record, isPromptEvent) {",
    "  const cache = cachePathsFor(record, isPromptEvent);",
    "  await fs.mkdir(cache.archiveRoot, { recursive: true });",
    "  await Promise.all([",
    "    fs.writeFile(cache.archiveMarkdownFile, renderMarkdown(record), 'utf8'),",
    "    fs.writeFile(cache.archiveJsonFile, `${JSON.stringify(record, null, 2)}\\n`, 'utf8'),",
    "    fs.writeFile(cache.latestFile, renderMarkdown(record), 'utf8'),",
    "    fs.writeFile(cache.latestJsonFile, `${JSON.stringify(record, null, 2)}\\n`, 'utf8'),",
    "  ]);",
    "}",
    "",
    "async function cleanupCacheRecord(record, isPromptEvent) {",
    "  const cache = cachePathsFor(record, isPromptEvent);",
    "  await Promise.allSettled([fs.unlink(cache.archiveMarkdownFile), fs.unlink(cache.archiveJsonFile)]);",
    "  const latest = await readJsonFile(cache.latestJsonFile);",
    "  if (latest && latest.sessionId === record.sessionId && latest.turnId === record.turnId && latest.role === record.role) {",
    "    await Promise.allSettled([fs.unlink(cache.latestFile), fs.unlink(cache.latestJsonFile)]);",
    "  }",
    "}",
    "",
    "async function readJsonFile(filePath) {",
    "  try {",
    "    return JSON.parse(await fs.readFile(filePath, 'utf8'));",
    "  } catch {",
    "    return null;",
    "  }",
    "}",
    "",
    "async function postToBridge(record, isPromptEvent, isEventOnly) {",
    "  let debugEnabled = false;",
    "  try {",
    "    const config = JSON.parse(await fs.readFile(adapterConfigFile, 'utf8'));",
    "    let url = null;",
    "    if (isEventOnly && typeof config.bridgeEventsUrl === 'string') url = config.bridgeEventsUrl;",
    "    if (!url && isPromptEvent && typeof config.bridgePromptsUrl === 'string') url = config.bridgePromptsUrl;",
    "    if (!url && !isPromptEvent && !isEventOnly && typeof config.bridgeRepliesUrl === 'string') url = config.bridgeRepliesUrl;",
    "    if (!url && isPromptEvent && typeof config.bridgeRepliesUrl === 'string') url = config.bridgeRepliesUrl.replace(/\\/api\\/replies$/u, '/api/prompts');",
    "    if (!url && isEventOnly && typeof config.bridgeRepliesUrl === 'string') url = config.bridgeRepliesUrl.replace(/\\/api\\/replies$/u, '/api/events');",
    "    debugEnabled = await readBridgeDebugEnabled(config, url);",
    "    if (!url || typeof fetch !== 'function') return { ok: false, debugEnabled };",
    "    const response = await fetchWithTimeout(url, {",
    "        method: 'POST',",
    "        headers: { 'content-type': 'application/json' },",
    "        body: JSON.stringify(record),",
    "      }, 2000);",
    "    return { ok: response.ok, debugEnabled };",
    "  } catch {",
    "    return { ok: false, debugEnabled };",
    "  }",
    "}",
    "",
    "async function readBridgeDebugEnabled(config, fallbackUrl) {",
    "  const candidates = [",
    "    config && config.bridgeDebugUrl,",
    "    fallbackUrl,",
    "    config && config.bridgeEventsUrl,",
    "    config && config.bridgeRepliesUrl,",
    "    config && config.bridgePromptsUrl,",
    "  ];",
    "  for (const candidate of candidates) {",
    "    if (typeof candidate !== 'string' || !candidate) continue;",
    "    try {",
    "      const debugUrl = new URL(candidate);",
    "      debugUrl.pathname = '/api/debug';",
    "      debugUrl.search = '';",
    "      const response = await fetchWithTimeout(debugUrl.toString(), { method: 'GET' }, 1200);",
    "      if (!response.ok) return false;",
    "      const body = await response.json();",
    "      return Boolean(body && body.enabled);",
    "    } catch {",
    "      return false;",
    "    }",
    "  }",
    "  return false;",
    "}",
    "",
    "async function fetchWithTimeout(url, options, timeoutMs) {",
    "  if (typeof fetch !== 'function') throw new Error('fetch is not available in this Node.js runtime');",
    "  const controller = new AbortController();",
    "  const timeout = setTimeout(() => controller.abort(), timeoutMs);",
    "  try {",
    "    return await fetch(url, { ...options, signal: controller.signal });",
    "  } finally {",
    "    clearTimeout(timeout);",
    "  }",
    "}",
    "",
    "function normalizeMessage(value) {",
    "  return typeof value === 'string' ? value.replace(/\\r\\n?/g, '\\n').trim() : '';",
    "}",
    "",
    "function fallbackEventMessage(payload, eventName) {",
    "  if (typeof payload.message === 'string') return payload.message;",
    "  if (typeof payload.reason === 'string') return payload.reason;",
    "  if (typeof payload.title === 'string') return payload.title;",
    "  if (typeof payload.error === 'string') return payload.error;",
    "  if (typeof payload.status === 'string') return payload.status;",
    "  if (typeof payload.tool_name === 'string') return payload.tool_name;",
    "  return eventName;",
    "}",
    "",
    "function inferHookState(payload, eventName, isPromptEvent, isReplyEvent, isStopEvent) {",
    "  if (isPromptEvent) return 'running';",
    "  if (isReplyEvent) return 'idle';",
    "  const lowerEventName = String(eventName || '').toLowerCase();",
    "  if (lowerEventName === 'pretooluse' || lowerEventName === 'posttooluse' || lowerEventName === 'posttoolusefailure') return 'running';",
    "  const combined = [eventName, payload.message, payload.reason, payload.title, payload.error, payload.status]",
    "    .filter((item) => typeof item === 'string')",
    "    .join(' ')",
    "    .toLowerCase();",
    "  if (combined.includes('permission') || combined.includes('approval')) return 'waiting_permission';",
    "  if (combined.includes('interrupt') || combined.includes('cancel') || combined.includes('abort')) return 'cancelled';",
    "  if (combined.includes('fail') || combined.includes('error')) return 'failed';",
    "  if (isStopEvent) return 'idle';",
    "  return null;",
    "}",
    "",
    "function fileSafeTimestamp(value) {",
    "  return value.replace(/[:.]/g, '-');",
    "}",
    "",
    "function sanitizeFilePart(value) {",
    "  return String(value || 'turn').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'turn';",
    "}",
    "",
  "function renderMarkdown(record) {",
  "  const lines = [",
  "    `- captured_at: ${record.capturedAt}`,",
    "    `- session_id: ${record.sessionId}`,",
    "    `- turn_id: ${record.turnId}`,",
    "    `- model: ${record.model ?? 'unknown-model'}`,",
    "    `- hook_event_name: ${record.hookEventName}`,",
    "    `- role: ${record.role}`,",
    "    `- stop_hook_active: ${record.stopHookActive}`,",
    "  ];",
    "  if (record.cwd) lines.push(`- cwd: ${record.cwd}`);",
    "  if (record.transcriptPath) lines.push(`- transcript_path: ${record.transcriptPath}`);",
    "  lines.push('', '---', '', record.message, '');",
    "  return lines.join('\\n');",
    "}",
    "",
  ].join("\n");
}

function mergeCodexHooks(workspacePath, hookScriptPath, amoRoot) {
  const codexDir = path.join(workspacePath, ".codex");
  const hookConfigPath = path.join(codexDir, "hooks.json");
  const command = `node "${hookScriptPath}"`;
  const hookEntry = {
    hooks: [
      {
        type: "command",
        command,
        timeout: 10,
        statusMessage: "AMO capture Codex lifecycle",
      },
    ],
  };

  fs.mkdirSync(codexDir, { recursive: true });

  const existed = fs.existsSync(hookConfigPath);
  const rawBefore = existed ? fs.readFileSync(hookConfigPath, "utf8") : "";
  const config = existed ? readJsonFileStrict(hookConfigPath) : {};
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw httpError(409, "invalid_codex_hooks", ".codex/hooks.json must be a JSON object");
  }

  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    config.hooks = {};
  }
  for (const eventName of CODEX_HOOK_EVENTS) {
    if (!Array.isArray(config.hooks[eventName])) {
      config.hooks[eventName] = [];
    }
    if (!JSON.stringify(config.hooks[eventName]).includes("codex-stop-message.mjs")) {
      config.hooks[eventName].push(hookEntry);
    }
  }

  const nextRaw = `${JSON.stringify(config, null, 2)}\n`;
  if (rawBefore === nextRaw) {
    return { changed: false, backups: [] };
  }

  const backups = [];
  if (existed) {
    const backupName = `codex-hooks-${fileSafeTimestamp(new Date().toISOString())}.json`;
    const backupPath = path.join(amoRoot, "backups", backupName);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(hookConfigPath, backupPath);
    backups.push(path.join(".amo", "backups", backupName));
  }

  writeTextFile(hookConfigPath, nextRaw);
  return { changed: true, backups };
}

function fileSafeTimestamp(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

module.exports = {
  CODEX_HOOK_EVENTS,
  codexReplyHookScript,
  mergeCodexHooks,
};
