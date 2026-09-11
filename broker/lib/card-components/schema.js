const { httpError } = require("../http");
const { timestamp } = require("../session-frameworks/common");
const { createDefinitions } = require("./registry");
const STATES = ["pending", "reviewing", "later", "future", "handled"];
const fail = (message) => { throw httpError(400, "invalid_card", message); };
function object(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail(`Invalid ${label}`);
}
function string(value, max, label, empty = false) {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim())) fail(`Invalid ${label}`);
}
function identifier(value, max = 128) { string(value, max, "identifier"); if (/[\u0000-\u001f\u007f]/u.test(value)) fail("Invalid identifier"); }
function integer(value, label) { if (!Number.isSafeInteger(value) || value < 0) fail(`Invalid ${label}`); }
function date(value, nullable = false) { if (!(nullable && value === null) && (typeof value !== "string" || timestamp(value) !== value)) fail("Invalid timestamp"); }
function json(value, depth = 0) {
  if (depth > 24) fail("Component payload is nested too deeply");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object") fail("Component payload must contain JSON values");
  for (const nested of Object.values(value)) json(nested, depth + 1);
}
function sessionRef(value) {
  object(value, ["frameworkId", "sessionId"], "session reference");
  if (typeof value.frameworkId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.frameworkId)) fail("Invalid framework ID");
  identifier(value.sessionId, 1024);
}
const isType = (component, type) => component.type === type && component.schemaVersion === 1;
const emptyAttention = () => ({ generation: 0, kind: null, updatedAt: null, hasUnseen: false });
function processingData(data, materialized) {
  object(data, materialized ? ["sourceComponentId", "state", "handledGeneration", "attention"] : ["sourceComponentId", "state"], "processing data");
  if (data.sourceComponentId !== null) identifier(data.sourceComponentId);
  if (!STATES.includes(data.state)) fail("Invalid processing state");
  if (materialized) {
    integer(data.handledGeneration, "handled generation");
    object(data.attention, ["generation", "kind", "updatedAt", "hasUnseen"], "attention");
    integer(data.attention.generation, "attention generation");
    if (![null, "reply", "permission", "input", "failure"].includes(data.attention.kind)) fail("Invalid attention kind");
    date(data.attention.updatedAt, true);
    if (data.handledGeneration > data.attention.generation || data.attention.hasUnseen !== (data.attention.generation > data.handledGeneration)) fail("Invalid attention acknowledgement");
  }
}
const definitions = createDefinitions({ object, identifier, string, sessionRef, processingData, emptyAttention });
const definitionFor = (value) => value.schemaVersion === 1 ? definitions.get(value.type) : undefined;
function component(value, materialized = false) {
  object(value, ["componentId", "type", "schemaVersion", "data"], "component");
  identifier(value.componentId);
  if (typeof value.type !== "string" || !/^[a-z][a-z0-9.-]{0,95}$/u.test(value.type)) fail("Invalid component namespace");
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) fail("Invalid component schema version");
  if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) fail("Component data must be an object");
  json(value.data);
  if (Buffer.byteLength(JSON.stringify(value.data)) > 32768) fail("Component data exceeds 32 KiB");
  const definition = definitionFor(value);
  definition?.validate(value.data, materialized);
  const result = JSON.parse(JSON.stringify(value));
  if (!materialized && definition?.initialize) result.data = definition.initialize(result.data);
  return result;
}
function components(values, materialized = false) {
  if (!Array.isArray(values) || values.length > 32) fail("Cards allow at most 32 components");
  const result = values.map((value) => component(value, materialized));
  validateGraph(result);
  return result;
}
function validateGraph(values) {
  const ids = new Map();
  for (const value of values) { if (ids.has(value.componentId)) fail("Component IDs must be unique"); ids.set(value.componentId, value); }
  const counts = new Map();
  const targets = new Set();
  for (const value of values) {
    const definition = definitionFor(value);
    if (!definition) continue;
    const count = (counts.get(value.type) || 0) + 1;
    counts.set(value.type, count);
    if (definition.maxCount && count > definition.maxCount) fail(`Too many ${value.type} components`);
    for (const reference of definition.references?.(value.data) || []) if (!isType(ids.get(reference) || {}, "amo.session")) fail("Component source must reference an existing session component");
    if (definition.uniqueTarget) {
      const key = JSON.stringify([value.type, definition.uniqueTarget(value.data)]);
      if (targets.has(key)) fail("Conversation source is ambiguous: use only one conversation component per Session component");
      targets.add(key);
    }
  }
}
function card(value) {
  object(value, ["schemaVersion", "cardId", "title", "revision", "createdAt", "updatedAt", "archivedAt", "components"], "card");
  if (value.schemaVersion !== 1 || typeof value.cardId !== "string" || !/^card-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.cardId)) fail("Invalid card identity or schema");
  string(value.title, 2000, "title"); integer(value.revision, "revision");
  date(value.createdAt); date(value.updatedAt); date(value.archivedAt, true);
  components(value.components, true);
  return value;
}
function commands(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 20) fail("A batch requires 1..20 commands");
  const seen = new Set();
  const result = values.map((value) => {
    if (!value || typeof value !== "object") fail("Invalid command");
    const commandFields = { "set-title": ["type", "title"], archive: ["type"], restore: ["type"], "set-component": ["type", "component"], "remove-component": ["type", "componentId"], "set-processing": ["type", "componentId", "state"], handle: ["type", "componentId", "throughGeneration"], "set-note": ["type", "componentId", "text"] };
    const fields = Object.hasOwn(commandFields, value.type) ? commandFields[value.type] : null;
    if (!fields) fail("Unsupported card command");
    object(value, fields, "command");
    if (value.type === "set-title") string(value.title, 2000, "title");
    if (value.componentId !== undefined) identifier(value.componentId);
    if (["remove-component", "set-processing", "handle", "set-note"].includes(value.type) && value.componentId === undefined) fail("Command requires componentId");
    if (value.type === "set-component") component(value.component);
    if (value.type === "set-processing" && !STATES.slice(0, 4).includes(value.state)) fail("Use handle to acknowledge attention");
    if (value.type === "handle") integer(value.throughGeneration, "throughGeneration");
    if (value.type === "set-note") string(value.text, 2000, "note", true);
    const key = JSON.stringify(value);
    if (seen.has(key)) fail("Duplicate commands are not allowed");
    seen.add(key);
    return JSON.parse(key);
  });
  return result;
}
module.exports = { STATES, fail, object, string, identifier, integer, date, sessionRef, isType, emptyAttention, component, components, validateGraph, card, commands };
