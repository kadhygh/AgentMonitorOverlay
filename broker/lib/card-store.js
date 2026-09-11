const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { httpError } = require("./http");
const { writeSnapshot } = require("./task-canvas-store");
const schema = require("./card-components/schema");
const groupSchema = require("./card-groups");
const { canonicalFrameworkId } = require("./session-frameworks");
const { hash, timestamp, text, observeAttention } = require("./session-frameworks/common");
const { projectSessionRuntime, projectConversationRuntime } = require("./card-components/session-runtime");

const clone = (value) => JSON.parse(JSON.stringify(value));
const sourceKey = (ref) => hash([ref.frameworkId, ref.sessionId]);
const processing = (card) => card.components.find((component) => schema.isType(component, "amo.processing"));
const emptyEvidence = (key) => ({ sourceKey: key, replyKeys: [], replyThrough: null, blockingIdentity: null, eventThrough: null });
function sourceFor(card, component) {
  if (!component || component.data.sourceComponentId === null) return null;
  const source = card.components.find((entry) => entry.componentId === component.data.sourceComponentId && schema.isType(entry, "amo.session"));
  return source ? source.data.sessionRef : null;
}
function sourceBinding(card, component) {
  const ref = sourceFor(card, component);
  return ref ? sourceKey(ref) : null;
}
function validateEvidence(evidence) {
  schema.object(evidence, ["sourceKey", "replyKeys", "replyThrough", "blockingIdentity", "eventThrough"], "attention evidence");
  for (const key of [evidence.sourceKey, evidence.blockingIdentity]) if (key !== null && (typeof key !== "string" || !/^[a-f0-9]{64}$/u.test(key))) schema.fail("Invalid attention identity evidence");
  if (!Array.isArray(evidence.replyKeys) || evidence.replyKeys.length > 128 || evidence.replyKeys.some((key) => typeof key !== "string" || !/^[a-f0-9]{64}$/u.test(key))) schema.fail("Invalid reply evidence");
  schema.date(evidence.replyThrough, true); schema.date(evidence.eventThrough, true);
}
function validateSnapshot(snapshot) {
  schema.object(snapshot, ["schemaVersion", "records", "defaultSessionCards", "operations", "groups", "groupRevision", "groupOperations", "reviewGroupId"], "Card snapshot");
  groupSchema.groups(snapshot.groups);
  groupSchema.reviewGroup(snapshot.reviewGroupId ?? null, snapshot.groups);
  schema.integer(snapshot.groupRevision, "task group revision");
  if (!Array.isArray(snapshot.groupOperations) || snapshot.groupOperations.length > 128) schema.fail("Invalid task group operation ledger");
  const groupOperations = new Set();
  for (const entry of snapshot.groupOperations) {
    schema.object(entry, ["operationId", "fingerprint", "result"], "task group operation");
    schema.identifier(entry.operationId, 256);
    if (groupOperations.has(entry.operationId) || typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(entry.fingerprint)) schema.fail("Invalid task group operation ledger");
    groupOperations.add(entry.operationId);
    groupSchema.snapshot(entry.result);
    if (entry.result.revision > snapshot.groupRevision) schema.fail("Invalid task group result revision");
  }
  if (snapshot.schemaVersion !== 1 || !snapshot.records || typeof snapshot.records !== "object" || Array.isArray(snapshot.records) || !snapshot.defaultSessionCards || typeof snapshot.defaultSessionCards !== "object" || Array.isArray(snapshot.defaultSessionCards) || !Array.isArray(snapshot.operations) || snapshot.operations.length > 128) schema.fail("Invalid Card snapshot");
  for (const [id, record] of Object.entries(snapshot.records)) {
    schema.object(record, ["card", "evidence"], "card record");
    schema.card(record.card);
    groupSchema.validateReferences(record.card, snapshot.groups);
    if (record.card.cardId !== id) schema.fail("Card storage identity mismatch");
    if (!record.evidence || typeof record.evidence !== "object" || Array.isArray(record.evidence)) schema.fail("Invalid evidence map");
    const component = processing(record.card);
    if (Object.keys(record.evidence).length !== (component ? 1 : 0)) schema.fail("Attention evidence does not match processing component");
    if (component) {
      const evidence = record.evidence[component.componentId];
      validateEvidence(evidence);
      if (evidence.sourceKey !== sourceBinding(record.card, component)) schema.fail("Attention evidence source mismatch");
    }
  }
  for (const [key, cardId] of Object.entries(snapshot.defaultSessionCards)) if (!/^[a-f0-9]{64}$/u.test(key) || !Object.hasOwn(snapshot.records, cardId)) schema.fail("Invalid default Session Card index");
  const ids = new Set();
  for (const entry of snapshot.operations) {
    schema.object(entry, ["operationId", "fingerprint", "card"], "operation");
    schema.identifier(entry.operationId, 256);
    if (ids.has(entry.operationId) || typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(entry.fingerprint)) schema.fail("Invalid operation ledger");
    ids.add(entry.operationId);
    schema.card(entry.card);
    if (!Object.hasOwn(snapshot.records, entry.card.cardId) || entry.card.revision > snapshot.records[entry.card.cardId].card.revision) schema.fail("Invalid operation result revision");
  }
}

function createCardStore({ dataFile, write = writeSnapshot, now = () => new Date().toISOString(), coalesceMs = 40, retryMs = 1000, recordDebugLog = () => {} }) {
  let state = { schemaVersion: 1, records: {}, defaultSessionCards: {}, operations: [], groups: [], groupRevision: 0, groupOperations: [], reviewGroupId: null };
  let corruption = null;
  let lastError = null;
  let queue = Promise.resolve();
  let pending = [];
  let timer = null;
  let unsubscribe = null;
  let disposed = false;
  let retryDelay = retryMs;
  let runtimeSessions = new Map();
  const observationErrors = new Map();
  try {
    const loaded = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    if (loaded && !["groups", "groupRevision", "groupOperations"].some((key) => Object.hasOwn(loaded, key))) Object.assign(loaded, { groups: [], groupRevision: 0, groupOperations: [] });
    validateSnapshot(loaded);
    loaded.reviewGroupId ??= null;
    for (const entry of loaded.groupOperations) entry.result.reviewGroupId ??= null;
    state = loaded;
  } catch (error) {
    if (error.code !== "ENOENT") corruption = httpError(500, "card_storage_error", `Card storage cannot be loaded: ${error.message}`);
  }
  function report(error) {
    lastError = error;
    recordDebugLog("broker", "cards.persistence_failed", { message: error.message });
  }
  function serialize(work) {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }
  async function persist(next) {
    validateSnapshot(next);
    try { await write(dataFile, next); }
    catch (error) { const failure = httpError(500, "card_write_failed", `Card changes could not be saved: ${error.message}`); report(failure); throw failure; }
    state = next;
    lastError = null;
    retryDelay = retryMs;
  }
  function newCard(title, components) {
    const at = now();
    const card = { schemaVersion: 1, cardId: `card-${randomUUID()}`, title, revision: 0, createdAt: at, updatedAt: at, archivedAt: null, components };
    const component = processing(card);
    return { card, evidence: component ? { [component.componentId]: emptyEvidence(sourceBinding(card, component)) } : {} };
  }
  function resolveSession(ref) {
    if (!ref) return null;
    const session = runtimeSessions.get(ref.sessionId);
    return session && session.sessionId === ref.sessionId && canonicalFrameworkId(session.tool) === ref.frameworkId ? session : null;
  }
  function normalizeObservation(session, seed = false) {
    const ref = { frameworkId: canonicalFrameworkId(session.tool), sessionId: session.sessionId };
    schema.sessionRef(ref);
    return { ref, sourceKey: sourceKey(ref), title: text(session.taskTitle || session.title || session.sessionId, 2000), attention: observeAttention(session), at: timestamp(session.updatedAt), seed, unavailable: Boolean(session.archivedAt || session.dismissedAt), reviewPending: Boolean(session.reviewRequired && session.reviewStatus !== "reviewed" && !session.reviewedAt), seedHandled: seed && session.reviewRequired !== true && session.reviewStatus !== "pending" };
  }
  function applyAttention(record, component, event, seedHandled = false) {
    const data = component.data;
    const evidence = record.evidence[component.componentId];
    if (!evidence || evidence.sourceKey !== event.sourceKey) return;
    function raise(kind, at) {
      data.attention = { generation: data.attention.generation + 1, kind, updatedAt: at || now(), hasUnseen: true };
      if (data.state === "handled") data.state = "pending";
    }
    const reply = event.attention.reply;
    const newReply = Boolean(reply && !reply.keys.some((key) => evidence.replyKeys.includes(key)) && (!evidence.replyThrough || reply.at > evidence.replyThrough));
    if (newReply) raise("reply", reply.at);
    if (reply) {
      const keys = [...evidence.replyKeys];
      for (const key of reply.keys) if (!keys.includes(key)) keys.push(key);
      evidence.replyKeys = keys.slice(-128);
      if (!evidence.replyThrough || reply.at > evidence.replyThrough) evidence.replyThrough = reply.at;
    }
    const blocking = event.attention.blocking;
    if (blocking) {
      if (blocking.identity !== evidence.blockingIdentity && (!blocking.at || !evidence.eventThrough || blocking.at >= evidence.eventThrough)) {
        raise(blocking.kind, blocking.at);
        evidence.blockingIdentity = blocking.identity;
        if (blocking.at && (!evidence.eventThrough || blocking.at > evidence.eventThrough)) evidence.eventThrough = blocking.at;
      }
    } else if ((!event.at || !evidence.eventThrough || event.at >= evidence.eventThrough) && evidence.blockingIdentity !== null) {
      evidence.blockingIdentity = null;
      if (event.at) evidence.eventThrough = event.at;
    }
    data.attention.hasUnseen = data.attention.generation > data.handledGeneration;
    if (seedHandled && !blocking) {
      data.state = "handled";
      data.handledGeneration = data.attention.generation;
      data.attention.hasUnseen = false;
    }
    return newReply;
  }
  function applyObservation(next, event) {
    let createdId = null;
    if (!next.defaultSessionCards[event.sourceKey]) {
      const components = schema.components([
        { componentId: "session", type: "amo.session", schemaVersion: 1, data: { sessionRef: event.ref } },
        { componentId: "conversation", type: "amo.conversation", schemaVersion: 1, data: { sessionComponentId: "session" } },
        { componentId: "processing", type: "amo.processing", schemaVersion: 1, data: { sourceComponentId: "session", state: "pending" } },
        { componentId: "notes", type: "amo.notes", schemaVersion: 1, data: { text: "" } },
      ]);
      const record = newCard(event.title, components);
      createdId = record.card.cardId;
      next.records[createdId] = record;
      next.defaultSessionCards[event.sourceKey] = createdId;
    }
    for (const record of Object.values(next.records)) {
      const component = processing(record.card);
      if (!component || sourceBinding(record.card, component) !== event.sourceKey) continue;
      const before = JSON.stringify(component.data);
      const newReply = applyAttention(record, component, event, record.card.cardId === createdId && event.seedHandled);
      // Only a newly observed completed reply may select the configured Review
      // group. Startup history, blocking events and duplicate hooks retain the
      // user's placement. Archived Cards/Sessions never re-enroll themselves.
      if (newReply && event.reviewPending && !event.seed && !event.unavailable && !record.card.archivedAt && next.reviewGroupId) {
        const group = record.card.components.find((entry) => schema.isType(entry, "amo.task-group"));
        if (group) group.data.groupId = next.reviewGroupId;
        else if (record.card.components.length < 32) record.card.components.push({ componentId: `task-group-${randomUUID()}`, type: "amo.task-group", schemaVersion: 1, data: { groupId: next.reviewGroupId } });
      }
      if (JSON.stringify(component.data) !== before) { record.card.revision += 1; record.card.updatedAt = now(); }
    }
  }
  async function flushPending() {
    if (corruption) throw corruption;
    if (!pending.length) return;
    const count = pending.length;
    const next = clone(state);
    for (const event of pending.slice(0, count)) applyObservation(next, event);
    if (JSON.stringify(next) !== JSON.stringify(state)) await persist(next);
    pending.splice(0, count);
  }
  function schedule(delay = coalesceMs) {
    if (timer || corruption || disposed) return;
    timer = setTimeout(() => { timer = null; void flush().catch(() => {}); }, delay);
    timer.unref?.();
  }
  function observe(change) {
    if (corruption || disposed) return;
    const sourceId = change.sessionId || change.session?.sessionId || "unknown";
    try {
      if (change.type === "set") {
        pending.push(normalizeObservation(change.session, change.seed === true));
        runtimeSessions.set(change.session.sessionId, change.session);
      } else {
        for (const session of change.type === "clear" ? change.sessions : [change.session]) {
          runtimeSessions.delete(session?.sessionId);
          observationErrors.delete(session?.sessionId);
        }
      }
      observationErrors.delete(sourceId);
      if (!observationErrors.size && lastError?.code === "card_observation_failed") lastError = null;
      if (pending.length) schedule();
    } catch (error) {
      const failure = httpError(500, "card_observation_failed", error.message);
      observationErrors.set(sourceId, failure); report(failure);
    }
  }
  function attach(sessions) {
    disposed = false;
    unsubscribe?.();
    // Keep runtime lookup in memory only; Card storage never duplicates execution snapshots.
    runtimeSessions = new Map(sessions);
    unsubscribe = sessions.observe(observe);
    for (const session of sessions.values()) observe({ type: "set", session, seed: true });
    return () => { unsubscribe?.(); unsubscribe = null; };
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    return serialize(flushPending).catch((error) => {
      if (pending.length && !corruption && !disposed) { schedule(retryDelay); retryDelay = Math.min(30000, retryDelay * 2); }
      throw error;
    });
  }
  async function list() {
    await flush();
    if (observationErrors.size) throw observationErrors.values().next().value;
    return { schemaVersion: 1, cards: Object.values(state.records).map((record) => clone(record.card)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.cardId.localeCompare(b.cardId)) };
  }
  async function get(cardId) {
    await flush();
    if (!Object.hasOwn(state.records, cardId)) throw httpError(404, "card_not_found", "Card does not exist");
    return clone(state.records[cardId].card);
  }
  const groupView = (snapshot = state) => ({ schemaVersion: 1, revision: snapshot.groupRevision, groups: clone(snapshot.groups), reviewGroupId: snapshot.reviewGroupId });
  function listGroups() {
    return serialize(async () => { await flushPending(); return groupView(); });
  }
  function executeGroups(payload) {
    let request;
    try { request = groupSchema.request(payload); } catch (error) { return Promise.reject(error); }
    return serialize(async () => {
      if (corruption) throw corruption;
      const fingerprint = hash(request);
      const previous = state.groupOperations.find((entry) => entry.operationId === request.operationId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw httpError(409, "card_group_operation_conflict", "operationId was used with a different task group request");
        return clone(previous.result);
      }
      await flushPending();
      if (request.expectedRevision !== state.groupRevision) throw httpError(409, "card_group_revision_conflict", `Expected task group revision ${request.expectedRevision}; current revision is ${state.groupRevision}`);
      const next = clone(state);
      const removed = new Set();
      for (const command of request.commands) {
        if (command.type === "create") next.groups.push({ groupId: `group-${randomUUID()}`, name: command.name, dragOnly: command.dragOnly });
        else if (command.type === "set-review-group") {
          if (command.groupId !== null && !next.groups.some((group) => group.groupId === command.groupId)) throw httpError(404, "card_group_not_found", "Task group does not exist");
          next.reviewGroupId = command.groupId;
        }
        else {
          const target = next.groups.find((group) => group.groupId === command.groupId);
          if (!target) throw httpError(404, "card_group_not_found", "Task group does not exist");
          if (command.type === "update") Object.assign(target, { name: command.name, dragOnly: command.dragOnly });
          else {
            next.groups = next.groups.filter((group) => group.groupId !== command.groupId); removed.add(command.groupId);
            if (next.reviewGroupId === command.groupId) next.reviewGroupId = null;
          }
        }
      }
      // Group removal and all Card references share the same durable transaction,
      // including archived Cards. Processing cursors and Sessions are untouched.
      for (const record of Object.values(next.records)) {
        const component = record.card.components.find((entry) => schema.isType(entry, "amo.task-group"));
        if (component && removed.has(component.data.groupId)) {
          component.data.groupId = null;
          record.card.revision += 1;
          record.card.updatedAt = now();
        }
      }
      next.groupRevision += 1;
      const result = groupView(next);
      next.groupOperations = [...next.groupOperations, { operationId: request.operationId, fingerprint, result }].slice(-128);
      await persist(next);
      return clone(result);
    });
  }
  function replay(request) {
    if (corruption) throw corruption;
    const fingerprint = hash(request);
    const entry = state.operations.find((operation) => operation.operationId === request.operationId);
    if (entry && entry.fingerprint !== fingerprint) throw httpError(409, "card_operation_conflict", "operationId was used with a different request");
    return entry ? clone(entry.card) : null;
  }
  async function commitResult(next, request, card) {
    next.operations = [...next.operations, { operationId: request.operationId, fingerprint: hash(request), card: clone(card) }].slice(-128);
    await persist(next);
    return clone(card);
  }
  function create(payload) {
    let request;
    try {
      schema.object(payload, ["operationId", "title", "components"], "create request");
      schema.identifier(payload.operationId, 256); schema.string(payload.title, 2000, "title");
      const components = schema.components(payload.components === undefined ? [] : payload.components);
      request = { operationId: payload.operationId, mode: "create", title: payload.title, components };
    } catch (error) { return Promise.reject(error); }
    return serialize(async () => {
      const previous = replay(request); if (previous) return previous;
      await flushPending();
      const next = clone(state);
      const record = newCard(request.title, clone(request.components));
      const component = processing(record.card);
      const runtime = resolveSession(sourceFor(record.card, component));
      if (runtime) applyAttention(record, component, normalizeObservation(runtime));
      next.records[record.card.cardId] = record;
      return commitResult(next, request, record.card);
    });
  }
  function fromSession(payload) {
    let request;
    try {
      schema.object(payload, ["operationId", "sessionRef", "groupId"], "Session Card request");
      schema.identifier(payload.operationId, 256); schema.sessionRef(payload.sessionRef); groupSchema.groupId(payload.groupId);
      request = { mode: "from-session", ...clone(payload) };
    } catch (error) { return Promise.reject(error); }
    return serialize(async () => {
      const previous = replay(request); if (previous) return previous;
      await flushPending();
      if (!state.groups.some((group) => group.groupId === request.groupId)) throw httpError(404, "card_group_not_found", "Task group does not exist");
      const runtime = resolveSession(request.sessionRef);
      if (!runtime || runtime.archivedAt || runtime.dismissedAt) throw httpError(409, "card_session_unavailable", "Session no longer exists or is archived");
      const next = clone(state);
      const key = sourceKey(request.sessionRef);
      // Observation and manual enrollment share the canonical index and writer.
      // No Session state or conversation binding is modified by this command.
      if (!next.defaultSessionCards[key]) applyObservation(next, normalizeObservation(runtime, true));
      const record = next.records[next.defaultSessionCards[key]];
      const current = processing(record.card);
      if (!current || sourceBinding(record.card, current) !== key) throw httpError(409, "card_source_changed", "The existing Card source was removed or changed; resolve its components before adding it");
      const group = record.card.components.find((entry) => schema.isType(entry, "amo.task-group"));
      const commands = [];
      if (record.card.archivedAt) commands.push({ type: "restore" });
      if (group?.data.groupId !== request.groupId) commands.push({ type: "set-component", component: { componentId: group?.componentId || `task-group-${randomUUID()}`, type: "amo.task-group", schemaVersion: 1, data: { groupId: request.groupId } } });
      if (commands.length) applyCommands(record, commands);
      return commitResult(next, request, record.card);
    });
  }
  function applyCommands(record, commands) {
    const original = clone(record.card);
    const card = record.card;
    const resetCommands = new Set();
    const replacedProcessing = new Set();
    for (const command of commands) {
      const target = card.components.find((component) => component.componentId === command.componentId);
      switch (command.type) {
        case "set-title": card.title = command.title; break;
        case "archive": card.archivedAt = now(); break;
        case "restore": card.archivedAt = null; break;
        case "set-component": {
          const replacement = schema.component(command.component);
          const index = card.components.findIndex((component) => component.componentId === replacement.componentId);
          const old = card.components[index];
          if (schema.isType(replacement, "amo.processing")) {
            if (replacement.data.state === "handled") schema.fail("Use handle to acknowledge existing Card attention");
            resetCommands.add(replacement.componentId);
            if (!old || !schema.isType(old, "amo.processing")) replacedProcessing.add(replacement.componentId);
            if (old && schema.isType(old, "amo.processing")) replacement.data = { ...clone(old.data), sourceComponentId: replacement.data.sourceComponentId, state: replacement.data.state };
          }
          if (index >= 0) card.components[index] = replacement; else card.components.push(replacement);
          break;
        }
        case "remove-component":
          if (!target) schema.fail("Component does not exist");
          card.components = card.components.filter((component) => component.componentId !== command.componentId);
          break;
        case "set-processing":
          if (!target || !schema.isType(target, "amo.processing")) schema.fail("Processing component does not exist");
          target.data.state = command.state;
          break;
        case "set-note":
          if (!target || !schema.isType(target, "amo.notes")) schema.fail("Notes component does not exist");
          target.data.text = command.text;
          break;
        case "handle":
          if (!target || !schema.isType(target, "amo.processing")) schema.fail("Processing component does not exist");
          if (command.throughGeneration !== target.data.attention.generation) throw httpError(409, "card_generation_conflict", "Handle requires the currently observed attention generation");
          target.data.handledGeneration = command.throughGeneration;
          target.data.attention.hasUnseen = false;
          target.data.state = "handled";
          break;
        default: schema.fail("Unsupported command");
      }
    }
    schema.components(card.components, true);
    const current = processing(card);
    const prior = processing(original);
    const changedSource = current && (!prior || replacedProcessing.has(current.componentId) || prior.componentId !== current.componentId || current.data.sourceComponentId !== prior.data.sourceComponentId || sourceBinding(card, current) !== sourceBinding(original, prior));
    if (changedSource) {
      if (!resetCommands.has(current.componentId)) schema.fail("Changing a processing source requires an explicit processing component mutation to reset its attention cursor");
      if (commands.some((command) => command.type === "handle" && command.componentId === current.componentId)) throw httpError(409, "card_source_changed", "Observe the new processing source before handling its attention");
      current.data.handledGeneration = 0;
      current.data.attention = schema.emptyAttention();
      record.evidence = { [current.componentId]: emptyEvidence(sourceBinding(card, current)) };
      const runtime = resolveSession(sourceFor(card, current));
      if (runtime) applyAttention(record, current, normalizeObservation(runtime));
    } else if (!current) record.evidence = {};
    card.revision += 1;
    card.updatedAt = now();
  }
  function executeRequest(request, makeCommands) {
    return serialize(async () => {
      const previous = replay(request); if (previous) return previous;
      await flushPending();
      const current = state.records[request.cardId]?.card;
      if (!current) throw httpError(404, "card_not_found", "Card does not exist");
      if (request.expectedRevision !== current.revision) throw httpError(409, "card_revision_conflict", `Expected revision ${request.expectedRevision}; current revision is ${current.revision}`);
      const commands = schema.commands(makeCommands(current));
      const next = clone(state);
      const record = next.records[request.cardId];
      applyCommands(record, commands);
      return commitResult(next, request, record.card);
    });
  }
  function execute(cardId, payload) {
    try {
      schema.identifier(cardId, 100);
      schema.object(payload, ["operationId", "expectedRevision", "commands"], "command request");
      schema.identifier(payload.operationId, 256); schema.integer(payload.expectedRevision, "expected revision");
      const commands = schema.commands(payload.commands);
      const request = { mode: "commands", cardId, operationId: payload.operationId, expectedRevision: payload.expectedRevision, commands };
      return executeRequest(request, () => commands);
    } catch (error) { return Promise.reject(error); }
  }
  function focusView(card) {
    const component = processing(card);
    if (!component) throw httpError(404, "focus_card_not_found", "Card has no processing component");
    const ref = sourceFor(card, component);
    const raw = resolveSession(ref);
    const sourceId = component.data.sourceComponentId;
    const conversation = sourceId === null ? null : card.components.find((entry) => schema.isType(entry, "amo.conversation") && entry.data.sessionComponentId === sourceId);
    const note = card.components.find((entry) => schema.isType(entry, "amo.notes"));
    const group = card.components.find((entry) => schema.isType(entry, "amo.task-group"));
    return { schemaVersion: 2, cardId: card.cardId, revision: card.revision, title: card.title, createdAt: card.createdAt, updatedAt: card.updatedAt, archivedAt: card.archivedAt, groupId: group?.data.groupId ?? null, triage: { state: component.data.state, note: note?.data.text || "", handledGeneration: component.data.handledGeneration }, attention: clone(component.data.attention), session: ref ? projectSessionRuntime(raw, clone(ref), sourceId) : null, conversation: conversation ? projectConversationRuntime(raw, clone(ref), conversation.componentId, sourceId) : null };
  }
  function listFocus({ includeArchived = false } = {}) {
    return serialize(async () => {
      await flushPending();
      if (observationErrors.size) throw observationErrors.values().next().value;
      // Read group registry and card references within the same serialized turn.
      const cards = Object.values(state.records).map((record) => record.card)
        .filter((card) => (includeArchived || !card.archivedAt) && processing(card))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.cardId.localeCompare(b.cardId)).map(focusView);
      return { schemaVersion: 2, cards, groups: clone(state.groups), groupRevision: state.groupRevision, reviewGroupId: state.reviewGroupId };
    });
  }
  function mutateFocus(cardId, payload) {
    try {
      schema.identifier(cardId, 100);
      schema.object(payload, ["operationId", "expectedRevision", "action", "state", "note", "throughGeneration"], "Focus request");
      schema.identifier(payload.operationId, 256); schema.integer(payload.expectedRevision, "expected revision");
      if (payload.note !== undefined) schema.string(payload.note, 2000, "note", true);
      if (payload.action === "set-triage") {
        if (payload.throughGeneration !== undefined || (payload.state === undefined && payload.note === undefined) || (payload.state !== undefined && !schema.STATES.slice(0, 4).includes(payload.state))) schema.fail("set-triage requires state or note without an acknowledgement");
      } else if (payload.action === "handle") {
        schema.integer(payload.throughGeneration, "throughGeneration"); if (payload.state !== undefined) schema.fail("handle cannot set an arbitrary state");
      } else schema.fail("Unsupported Focus action");
      const request = { mode: "focus", cardId, ...clone(payload) };
      return executeRequest(request, (card) => {
        const component = processing(card);
        if (!component || card.archivedAt) throw httpError(404, "focus_card_not_found", "Card is not in Focus");
        const commands = [];
        if (request.state !== undefined) commands.push({ type: "set-processing", componentId: component.componentId, state: request.state });
        if (request.action === "handle") commands.push({ type: "handle", componentId: component.componentId, throughGeneration: request.throughGeneration });
        if (request.note !== undefined) {
          const notes = card.components.find((entry) => schema.isType(entry, "amo.notes"));
          if (notes) commands.push({ type: "set-note", componentId: notes.componentId, text: request.note });
          else commands.push({ type: "set-component", component: { componentId: `notes-${randomUUID()}`, type: "amo.notes", schemaVersion: 1, data: { text: request.note } } });
        }
        return commands;
      }).then(focusView);
    } catch (error) { return Promise.reject(error); }
  }
  async function dispose() { disposed = true; unsubscribe?.(); unsubscribe = null; await flush(); }
  return { attach, observe, flush, list, get, create, fromSession, execute, listGroups, executeGroups, listFocus, mutateFocus, focusView, dispose, status: () => ({ pending: pending.length, error: (corruption || observationErrors.values().next().value || lastError)?.message || null }) };
}

module.exports = { createCardStore, validateSnapshot };
