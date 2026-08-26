const fs = require("fs");
const path = require("path");
const { httpError } = require("../lib/http");
const { readJsonFileStrict, writeTextFile } = require("../lib/filesystem");
const { lifecycleMessageHookScript } = require("./claude");

const GROK_HOOK_EVENTS = Object.freeze([
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "StopCancelled",
  "SessionEnd",
  "PermissionDenied",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
]);

const GROK_PROJECT_HOOK_CONFIG_PATH = ".grok/hooks/amo.json";
const GROK_PROJECT_HOOK_PATH = ".amo/hooks/grok-message.mjs";
const GROK_PROJECT_HOOK_COMMAND = [
  'node -e "',
  "const fs=require('node:fs'),path=require('node:path'),url=require('node:url');",
  "let root=process.cwd(),script;",
  "for(;;){",
  "script=path.join(root,'.amo','hooks','grok-message.mjs');",
  "if(fs.existsSync(script))break;",
  "const parent=path.dirname(root);",
  "if(parent===root)process.exit(1);",
  "root=parent;",
  "}",
  "import(url.pathToFileURL(script).href).catch(()=>process.exit(1));",
  '"',
].join("");

function grokMessageHookScript(options = {}) {
  return lifecycleMessageHookScript({
    ...options,
    adapterId: "grok-build",
    cacheDirectory: "grok-cache",
    errorLogName: "grok-hook-errors.log",
    hookEvents: GROK_HOOK_EVENTS,
    tool: "grok",
    toolLabel: "Grok Build",
  });
}

function mergeGrokHooks(workspacePath, amoRoot) {
  const configPath = path.join(workspacePath, GROK_PROJECT_HOOK_CONFIG_PATH);
  const hookEntry = {
    hooks: [
      {
        type: "command",
        command: GROK_PROJECT_HOOK_COMMAND,
        timeout: 10,
      },
    ],
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const existed = fs.existsSync(configPath);
  const rawBefore = existed ? fs.readFileSync(configPath, "utf8") : "";
  const config = existed ? readJsonFileStrict(configPath) : {};
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw httpError(409, "invalid_grok_hooks", `${GROK_PROJECT_HOOK_CONFIG_PATH} must be a JSON object`);
  }

  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    config.hooks = {};
  }
  for (const eventName of Object.keys(config.hooks)) {
    if (!Array.isArray(config.hooks[eventName])) continue;
    config.hooks[eventName] = removeManagedHookEntries(config.hooks[eventName], "grok-message.mjs");
    if (config.hooks[eventName].length === 0 && !GROK_HOOK_EVENTS.includes(eventName)) {
      delete config.hooks[eventName];
    }
  }
  for (const eventName of GROK_HOOK_EVENTS) {
    if (!Array.isArray(config.hooks[eventName])) config.hooks[eventName] = [];
    config.hooks[eventName].push(grokHookEntryForEvent(eventName, hookEntry));
  }

  const nextRaw = `${JSON.stringify(config, null, 2)}\n`;
  if (rawBefore === nextRaw) return { changed: false, backups: [] };

  const backups = [];
  if (existed) {
    const backupName = `grok-hooks-${fileSafeTimestamp(new Date().toISOString())}.json`;
    const backupPath = path.join(amoRoot, "backups", backupName);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(configPath, backupPath);
    backups.push(path.join(".amo", "backups", backupName));
  }

  writeTextFile(configPath, nextRaw);
  return { changed: true, backups };
}

function grokHookEntryForEvent(eventName, hookEntry) {
  if (["UserPromptSubmit", "Stop"].includes(eventName)) return hookEntry;
  if (eventName === "Notification") return { matcher: "permission_prompt", hooks: hookEntry.hooks };
  return { matcher: ".*", hooks: hookEntry.hooks };
}

function removeManagedHookEntries(entries, scriptName) {
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) return [entry];
    const hooks = entry.hooks.filter((hook) => !String(hook?.command || "").includes(scriptName));
    return hooks.length > 0 ? [{ ...entry, hooks }] : [];
  });
}

function fileSafeTimestamp(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

module.exports = {
  GROK_HOOK_EVENTS,
  GROK_PROJECT_HOOK_COMMAND,
  GROK_PROJECT_HOOK_CONFIG_PATH,
  GROK_PROJECT_HOOK_PATH,
  grokMessageHookScript,
  mergeGrokHooks,
};
