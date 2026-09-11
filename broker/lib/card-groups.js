const schema = require("./card-components/schema");

function groupId(value) {
  if (typeof value !== "string" || !/^group-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) schema.fail("Invalid task group ID");
}
function groups(values) {
  if (!Array.isArray(values) || values.length > 128) schema.fail("At most 128 task groups are allowed");
  const ids = new Set();
  for (const value of values) {
    schema.object(value, ["groupId", "name", "dragOnly"], "task group");
    groupId(value.groupId); schema.string(value.name, 200, "task group name");
    if (typeof value.dragOnly !== "boolean" || ids.has(value.groupId)) schema.fail("Invalid task group");
    ids.add(value.groupId);
  }
}
function snapshot(value) {
  schema.object(value, ["schemaVersion", "revision", "groups", "reviewGroupId"], "task group snapshot");
  if (value.schemaVersion !== 1) schema.fail("Invalid task group schema version");
  schema.integer(value.revision, "task group revision"); groups(value.groups);
  reviewGroup(value.reviewGroupId ?? null, value.groups);
}
function reviewGroup(value, values) {
  if (value === null) return;
  groupId(value);
  if (!values.some((group) => group.groupId === value)) schema.fail("Review task group does not exist");
}
function request(payload) {
  schema.object(payload, ["operationId", "expectedRevision", "commands"], "task group request");
  schema.identifier(payload.operationId, 256); schema.integer(payload.expectedRevision, "task group expected revision");
  if (!Array.isArray(payload.commands) || payload.commands.length < 1 || payload.commands.length > 20) schema.fail("A task group batch requires 1..20 commands");
  for (const command of payload.commands) {
    if (!command || !["create", "update", "delete", "set-review-group"].includes(command.type)) schema.fail("Unsupported task group command");
    schema.object(command, command.type === "create" ? ["type", "name", "dragOnly"] : command.type === "update" ? ["type", "groupId", "name", "dragOnly"] : ["type", "groupId"], "task group command");
    if (command.type !== "create" && !(command.type === "set-review-group" && command.groupId === null)) groupId(command.groupId);
    if (["create", "update"].includes(command.type)) {
      schema.string(command.name, 200, "task group name");
      if (typeof command.dragOnly !== "boolean") schema.fail("Task group dragOnly must be boolean");
    }
  }
  return JSON.parse(JSON.stringify(payload));
}
function validateReferences(card, values) {
  for (const component of card.components) {
    if (schema.isType(component, "amo.task-group") && component.data.groupId !== null && !values.some((group) => group.groupId === component.data.groupId)) schema.fail("Task group does not exist");
  }
}
module.exports = { groupId, groups, snapshot, request, validateReferences, reviewGroup };
