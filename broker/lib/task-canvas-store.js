const fs = require("fs");
const path = require("path");
const { randomUUID, createHash } = require("crypto");
const { httpError } = require("./http");

const MAX_OPERATIONS = 32;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const clone = (value) => JSON.parse(JSON.stringify(value));
const invalid = (message) => { throw httpError(400, "invalid_task_canvas", message); };

function object(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid(`${name} contains unknown fields`);
}
function identifier(value, name, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${name} must be a nonempty bounded identifier`);
  return value;
}
function number(value, min, max, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) invalid(`${name} is out of bounds`);
  return value;
}
function validateDocument(value) {
  object(value, ["nodes", "edges", "viewport"], "document");
  if (!Array.isArray(value.nodes) || value.nodes.length > 500) invalid("At most 500 nodes are allowed");
  if (!Array.isArray(value.edges) || value.edges.length > 1000) invalid("At most 1000 edges are allowed");
  const ids = new Set();
  const nodes = value.nodes.map((node) => {
    object(node, ["id", "kind", "x", "y", "width", "height", "sessionId", "text"], "node");
    const id = identifier(node.id, "node.id");
    if (ids.has(id)) invalid("Node IDs must be unique");
    ids.add(id);
    const result = { id, kind: node.kind, x: number(node.x, -1000000, 1000000, "node.x"), y: number(node.y, -1000000, 1000000, "node.y"), width: number(node.width, 1, 10000, "node.width"), height: number(node.height, 1, 10000, "node.height") };
    if (node.kind === "task") {
      if (node.text !== undefined) invalid("Task nodes cannot contain note text");
      result.sessionId = identifier(node.sessionId, "node.sessionId", 1024);
    } else if (node.kind === "note") {
      if (node.sessionId !== undefined || typeof node.text !== "string" || node.text.length > 4000) invalid("Note nodes require text of at most 4000 characters and no sessionId");
      result.text = node.text;
    } else invalid("Unsupported node kind");
    return result;
  });
  const edgeIds = new Set();
  const pairs = new Set();
  const edges = value.edges.map((edge) => {
    object(edge, ["id", "source", "target"], "edge");
    const id = identifier(edge.id, "edge.id");
    const source = identifier(edge.source, "edge.source");
    const target = identifier(edge.target, "edge.target");
    const pair = JSON.stringify([source, target]);
    if (edgeIds.has(id) || pairs.has(pair) || source === target || !ids.has(source) || !ids.has(target)) invalid("Edges require unique IDs, distinct existing endpoints and unique directed pairs");
    edgeIds.add(id);
    pairs.add(pair);
    return { id, source, target };
  });
  object(value.viewport, ["x", "y", "zoom"], "viewport");
  return { nodes, edges, viewport: { x: number(value.viewport.x, -1000000, 1000000, "viewport.x"), y: number(value.viewport.y, -1000000, 1000000, "viewport.y"), zoom: number(value.viewport.zoom, 0.2, 2, "viewport.zoom") } };
}

function validateBoard(board) {
  object(board, ["schemaVersion", "id", "revision", "updatedAt", "document"], "board");
  if (board.schemaVersion !== 1 || board.id !== "default" || !Number.isSafeInteger(board.revision) || board.revision < 0 || (board.revision === 0 ? board.updatedAt !== null : typeof board.updatedAt !== "string" || !Number.isFinite(Date.parse(board.updatedAt)))) invalid("Invalid stored board metadata");
  return { schemaVersion: 1, id: "default", revision: board.revision, updatedAt: board.updatedAt, document: validateDocument(board.document) };
}

// Flush a same-directory temporary file before atomically replacing the committed snapshot.
// No in-memory state changes until replacement succeeds; failed writes leave the old file intact.
async function writeSnapshot(dataFile, snapshot) {
  await fs.promises.mkdir(path.dirname(dataFile), { recursive: true });
  const temporary = `${dataFile}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.promises.open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(snapshot), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, dataFile);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

function createTaskCanvasStore({ dataFile, write = writeSnapshot, now = () => new Date().toISOString() }) {
  let state = { board: { schemaVersion: 1, id: "default", revision: 0, updatedAt: null, document: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } }, operations: [] };
  let storageError = null;
  let queue = Promise.resolve();
  try {
    const loaded = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    object(loaded, ["board", "operations"], "snapshot");
    const board = validateBoard(loaded.board);
    if (!Array.isArray(loaded.operations) || loaded.operations.length > MAX_OPERATIONS || Buffer.byteLength(JSON.stringify(loaded.operations)) > MAX_LEDGER_BYTES) invalid("Invalid operation ledger");
    const operationIds = new Set();
    let previousRevision = 0;
    const operations = loaded.operations.map((entry) => {
      object(entry, ["operationId", "fingerprint", "board"], "operation");
      identifier(entry.operationId, "operationId");
      if (operationIds.has(entry.operationId) || typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(entry.fingerprint)) invalid("Invalid operation ledger entry");
      operationIds.add(entry.operationId);
      const result = validateBoard(entry.board);
      if (result.revision <= previousRevision || result.revision > board.revision) invalid("Invalid operation ledger revision");
      const expectedFingerprint = createHash("sha256").update(JSON.stringify({ expectedRevision: result.revision - 1, document: result.document })).digest("hex");
      if (entry.fingerprint !== expectedFingerprint) invalid("Stored operation fingerprint does not match its result");
      previousRevision = result.revision;
      return { operationId: entry.operationId, fingerprint: entry.fingerprint, board: result };
    });
    if (board.revision > 0 && (!operations.length || JSON.stringify(operations.at(-1).board) !== JSON.stringify(board))) invalid("Operation ledger does not match committed board");
    state = { board, operations };
  } catch (error) {
    if (error.code !== "ENOENT") storageError = httpError(500, "task_canvas_storage_error", `Task Canvas storage cannot be loaded: ${error.message}`);
  }
  function getBoard() {
    if (storageError) throw storageError;
    return clone(state.board);
  }
  function commit(payload) {
    let request;
    try {
      object(payload, ["operationId", "expectedRevision", "document"], "request");
      const operationId = identifier(payload.operationId, "operationId");
      if (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0) invalid("expectedRevision must be a nonnegative safe integer");
      request = { operationId, expectedRevision: payload.expectedRevision, document: validateDocument(payload.document) };
    } catch (error) { return Promise.reject(error); }
    const pending = queue.then(async () => {
      if (storageError) throw storageError;
      const fingerprint = createHash("sha256").update(JSON.stringify({ expectedRevision: request.expectedRevision, document: request.document })).digest("hex");
      const replay = state.operations.find((entry) => entry.operationId === request.operationId);
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw httpError(409, "task_canvas_operation_conflict", "operationId was already used with a different request");
        return clone(replay.board);
      }
      if (request.expectedRevision !== state.board.revision) throw httpError(409, "task_canvas_revision_conflict", `Expected revision ${request.expectedRevision}; current revision is ${state.board.revision}`);
      if (state.board.revision === Number.MAX_SAFE_INTEGER) throw httpError(409, "task_canvas_revision_exhausted", "Board revision limit reached");
      const board = { schemaVersion: 1, id: "default", revision: state.board.revision + 1, updatedAt: now(), document: request.document };
      const operations = [...state.operations, { operationId: request.operationId, fingerprint, board }].slice(-MAX_OPERATIONS);
      while (operations.length > 1 && Buffer.byteLength(JSON.stringify(operations)) > MAX_LEDGER_BYTES) operations.shift();
      const next = { board, operations };
      try { await write(dataFile, next); }
      catch (error) { throw httpError(500, "task_canvas_write_failed", `Task Canvas could not be saved: ${error.message}`); }
      state = next;
      return clone(board);
    });
    queue = pending.catch(() => {});
    return pending;
  }
  return { getBoard, commit };
}

module.exports = { createTaskCanvasStore, validateDocument, identifier, writeSnapshot };
