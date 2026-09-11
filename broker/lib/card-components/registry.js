// Explicit built-in component definitions. Unknown types/versions remain opaque data.
// Adding a data component does not require adding provider fields to Card core.
function createDefinitions(helpers) {
  const { object, identifier, string, sessionRef, processingData, emptyAttention } = helpers;
  return new Map([
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
