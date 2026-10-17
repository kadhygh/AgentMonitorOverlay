// Explicit built-in component definitions. Unknown types/versions remain opaque data.
// Adding a data component does not require adding provider fields to Card core.
function createDefinitions(helpers) {
  const { object, identifier, string, sessionRef, processingData, emptyAttention } = helpers;
  return new Map([
    ["amo.launch", {
      validate(data) {
        object(data, ["operationId", "fingerprint", "launchId", "workspacePath", "workspaceId", "prompt", "presetId", "reasoningEffort", "afterLaunch", "attempts", "launchEnvironment"], "launch data");
        for (const key of ["operationId", "fingerprint", "launchId", "workspaceId", "presetId", "reasoningEffort", "afterLaunch"]) identifier(data[key], 256);
        string(data.workspacePath, 4096, "workspace path"); string(data.prompt, 8000, "first prompt", true);
        if (!/^[a-f0-9]{64}$/u.test(data.fingerprint) || !["medium", "high", "xhigh"].includes(data.reasoningEffort) || !["cli", "amo"].includes(data.afterLaunch) || !["windows-powershell", "powershell7", "alacritty-powershell7"].includes(data.launchEnvironment)) throw new Error("Invalid launch configuration");
        if (!Array.isArray(data.attempts) || !data.attempts.length || data.attempts.length > 64) throw new Error("Invalid launch attempts");
        for (const attempt of data.attempts) { object(attempt, ["operationId", "launchId"], "launch attempt"); identifier(attempt.operationId, 256); identifier(attempt.launchId, 256); }
        if (new Set(data.attempts.map((a) => a.operationId)).size !== data.attempts.length || new Set(data.attempts.map((a) => a.launchId)).size !== data.attempts.length || data.attempts[0].operationId !== data.operationId || data.attempts.at(-1).launchId !== data.launchId) throw new Error("Invalid launch attempt identity");
      },
      maxCount: 1,
    }],
    ["amo.session", {
      validate(data) { object(data, ["sessionRef"], "session data"); sessionRef(data.sessionRef); },
    }],
    ["amo.conversation", {
      validate(data) { object(data, ["sessionComponentId"], "conversation data"); identifier(data.sessionComponentId); },
      references: (data) => [data.sessionComponentId],
      uniqueTarget: (data) => data.sessionComponentId,
    }],
    ["amo.processing", {
      validate: processingData,
      initialize: (data) => ({ ...data, handledGeneration: 0, attention: emptyAttention() }),
      references: (data) => data.sourceComponentId === null ? [] : [data.sourceComponentId],
      maxCount: 1,
    }],
    ["amo.notes", {
      validate(data) { object(data, ["text"], "notes data"); string(data.text, 2000, "note", true); },
      maxCount: 1,
    }],
    ["amo.task-group", {
      validate(data) { object(data, ["groupId"], "task group data"); if (data.groupId !== null) identifier(data.groupId, 100); },
      maxCount: 1,
    }],
  ]);
}
module.exports = { createDefinitions };
