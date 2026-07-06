const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  AMO_CANVAS_PATH,
  AMO_LAYOUT_VERSION,
  AMO_NOTE_INDEX_PATH,
  AMO_SCHEMA_VERSION,
  AMO_SESSION_GENERATED_PATH,
  AMO_SESSIONS_PATH,
} = require("./amo-constants");
const { readJsonFile, writeJsonFile, writeTextFile } = require("./filesystem");
const { normalizeText } = require("./normalize");
const { normalizeNoteDisplayTitle, sanitizeFilePart, sanitizeObsidianFileNamePart } = require("./text-format");

function writeReplyNote(amoRoot, vaultRoot, record) {
  const noteIdentity = nextConversationNoteIdentity(vaultRoot, record, "reply");
  const notePath = toVaultRelativePath(vaultRoot, noteIdentity.noteAbsolutePath);
  const noteMetadata = conversationNoteMetadata({
    record,
    noteIdentity,
    notePath,
    role: "assistant",
    kind: "reply",
  });
  const body = [
    renderAmoNoteMarker(noteMetadata),
    "",
    record.message,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  writeTextFile(noteIdentity.noteAbsolutePath, body);
  upsertConversationNoteIndex(amoRoot, noteMetadata);
  writeConversationSessionManifest(vaultRoot, record, noteMetadata);
  return { ...noteIdentity, ...noteMetadata, notePath };
}

function writePromptNote(amoRoot, vaultRoot, record) {
  const noteIdentity = nextConversationNoteIdentity(vaultRoot, record, "prompt");
  const notePath = toVaultRelativePath(vaultRoot, noteIdentity.noteAbsolutePath);
  const noteMetadata = conversationNoteMetadata({
    record,
    noteIdentity,
    notePath,
    role: "user",
    kind: "prompt",
  });
  const body = [
    renderAmoNoteMarker(noteMetadata),
    "",
    record.message,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  writeTextFile(noteIdentity.noteAbsolutePath, body);
  upsertConversationNoteIndex(amoRoot, noteMetadata);
  writeConversationSessionManifest(vaultRoot, record, noteMetadata);
  return { ...noteIdentity, ...noteMetadata, notePath };
}

function conversationNoteMetadata({ record, noteIdentity, notePath, role, kind }) {
  const displayTitle = normalizeNoteDisplayTitle(record.displayTitle || record.display_title);
  const noteId = `note_${crypto
    .createHash("sha1")
    .update(`${record.workspaceId}:${record.sessionId}:${record.turnId}:${kind}:${noteIdentity.sequence}:${record.capturedAt}`)
    .digest("hex")
    .slice(0, 16)}`;

  return {
    schemaVersion: AMO_SCHEMA_VERSION,
    noteId,
    workspaceId: record.workspaceId,
    workspacePath: record.workspacePath,
    notePath,
    tool: record.tool,
    role,
    kind,
    sequence: noteIdentity.sequence,
    displayName: noteIdentity.displayName,
    displayTitle,
    sessionId: record.sessionId,
    turnId: record.turnId,
    cwd: record.cwd,
    source: record.source,
    capturedAt: record.capturedAt,
    pendingPromptId: record.pendingPromptId || null,
    transcriptPath: record.transcriptPath || null,
    model: record.model || null,
    updatedAt: record.capturedAt,
  };
}

function renderAmoNoteMarker(metadata) {
  const marker = {
    schemaVersion: AMO_SCHEMA_VERSION,
    noteId: metadata.noteId,
    workspaceId: metadata.workspaceId,
    kind: metadata.kind,
    role: metadata.role,
    sequence: metadata.sequence,
    displayName: metadata.displayName,
    displayTitle: metadata.displayTitle,
    sessionId: metadata.sessionId,
    turnId: metadata.turnId,
    tool: metadata.tool,
  };
  const json = JSON.stringify(compactObject(marker)).replace(/--/g, "-\\u002d");
  return `<!-- amo: ${json} -->`;
}

function readConversationNoteIndex(amoRoot) {
  const indexPath = path.join(amoRoot, AMO_NOTE_INDEX_PATH);
  const index = readJsonFile(indexPath, null);
  if (!index || typeof index !== "object" || Array.isArray(index)) {
    return { schemaVersion: AMO_SCHEMA_VERSION, notes: {}, byPath: {} };
  }
  if (!index.notes || typeof index.notes !== "object" || Array.isArray(index.notes)) {
    index.notes = {};
  }
  if (!index.byPath || typeof index.byPath !== "object" || Array.isArray(index.byPath)) {
    index.byPath = {};
  }
  index.schemaVersion = index.schemaVersion || AMO_SCHEMA_VERSION;
  return index;
}

function upsertConversationNoteIndex(amoRoot, metadata) {
  const noteId = normalizeText(metadata.noteId);
  const notePath = normalizeText(metadata.notePath);
  if (!noteId || !notePath) return null;

  const index = readConversationNoteIndex(amoRoot);
  const previous = index.notes[noteId] || {};
  const nextRecord = compactObject({
    ...previous,
    ...metadata,
    schemaVersion: AMO_SCHEMA_VERSION,
    noteId,
    notePath,
    updatedAt: normalizeText(metadata.updatedAt) || new Date().toISOString(),
  });
  index.notes[noteId] = nextRecord;
  index.byPath[notePath] = noteId;
  writeJsonFile(path.join(amoRoot, AMO_NOTE_INDEX_PATH), index);
  return nextRecord;
}

function compactObject(value) {
  const result = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item === null || item === undefined || item === "") continue;
    result[key] = item;
  }
  return result;
}

function vaultRelativePath(...parts) {
  return parts
    .flatMap((part) => String(part || "").split(/[\\/]+/u))
    .filter(Boolean)
    .join("/");
}

function vaultRelativeToAbsolutePath(vaultRoot, relativePath) {
  return path.join(vaultRoot, ...String(relativePath || "").split(/[\\/]+/u).filter(Boolean));
}

function conversationSessionFolderName(record) {
  return sanitizeFilePart(record?.sessionId || "unknown-session");
}

function conversationSessionRootPath(record) {
  return vaultRelativePath(AMO_SESSIONS_PATH, conversationSessionFolderName(record));
}

function conversationGeneratedNotesPath(record) {
  return vaultRelativePath(conversationSessionRootPath(record), AMO_SESSION_GENERATED_PATH);
}

function writeConversationSessionManifest(vaultRoot, record, noteMetadata) {
  const sessionRoot = conversationSessionRootPath(record);
  const manifestPath = vaultRelativePath(sessionRoot, "session.json");
  const manifestAbsolutePath = vaultRelativeToAbsolutePath(vaultRoot, manifestPath);
  const existing = readJsonFile(manifestAbsolutePath, null);
  const existingNotes = Array.isArray(existing?.notes) ? existing.notes : [];
  const nextNotes = existingNotes.filter((item) => normalizeText(item?.noteId) !== noteMetadata.noteId);
  nextNotes.push({
    noteId: noteMetadata.noteId,
    notePath: noteMetadata.notePath,
    kind: noteMetadata.kind,
    role: noteMetadata.role,
    sequence: noteMetadata.sequence,
    displayName: noteMetadata.displayName,
    turnId: noteMetadata.turnId,
    source: noteMetadata.source,
    capturedAt: noteMetadata.capturedAt,
  });

  writeJsonFile(manifestAbsolutePath, {
    schemaVersion: AMO_SCHEMA_VERSION,
    layoutVersion: AMO_LAYOUT_VERSION,
    workspaceId: record.workspaceId,
    workspacePath: record.workspacePath,
    sessionId: record.sessionId,
    tool: record.tool,
    cwd: record.cwd,
    generatedPath: conversationGeneratedNotesPath(record),
    baseCanvasPath: AMO_CANVAS_PATH,
    createdAt: normalizeText(existing?.createdAt) || record.capturedAt || new Date().toISOString(),
    updatedAt: record.capturedAt || new Date().toISOString(),
    notes: nextNotes,
  });
}

function nextConversationNoteIdentity(vaultRoot, record, kind) {
  const noteKind = kind === "prompt" ? "prompt" : "reply";
  const noteDir = vaultRelativeToAbsolutePath(vaultRoot, conversationGeneratedNotesPath(record));
  fs.mkdirSync(noteDir, { recursive: true });

  const sequence = nextConversationNoteSequence(noteDir);
  const displayName = conversationNoteDisplayName(sequence, noteKind, record);
  const noteAbsolutePath = path.join(noteDir, `${displayName}.md`);
  return {
    kind: noteKind,
    role: noteKind === "prompt" ? "user" : "assistant",
    sequence,
    displayName,
    noteAbsolutePath,
  };
}

function conversationNoteDisplayName(sequence, noteKind, record) {
  const baseName = `${formatConversationNoteSequence(sequence)} ${noteKind}`;
  const titleSuffix = conversationNoteTitleSuffix(record);
  return titleSuffix ? `${baseName} - ${titleSuffix}` : baseName;
}

function conversationNoteTitleSuffix(record) {
  const title = normalizeNoteDisplayTitle(record?.taskTitle || record?.displayTitle || record?.title);
  if (!title) return "";
  return sanitizeObsidianFileNamePart(title).slice(0, 60).trim();
}

function nextConversationNoteSequence(noteDir) {
  const orderedNoteNamePattern = /^(\d+) (prompt|reply)(?: - .+)?\.md$/iu;
  const legacyNoteNamePattern = /^(prompt|reply) (\d+)(?: - .+)?\.md$/iu;
  let maxSequence = 0;
  let generatedNoteCount = 0;

  for (const entry of fs.readdirSync(noteDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const orderedMatch = entry.name.match(orderedNoteNamePattern);
    const legacyMatch = entry.name.match(legacyNoteNamePattern);
    if (!orderedMatch && !legacyMatch) continue;

    generatedNoteCount += 1;
    const sequence = Number.parseInt(orderedMatch?.[1] || legacyMatch?.[2] || "", 10);
    if (Number.isSafeInteger(sequence) && sequence > maxSequence) {
      maxSequence = sequence;
    }
  }

  let nextSequence = Math.max(maxSequence, generatedNoteCount) + 1;
  while (
    fs.existsSync(path.join(noteDir, `${formatConversationNoteSequence(nextSequence)} prompt.md`)) ||
    fs.existsSync(path.join(noteDir, `${formatConversationNoteSequence(nextSequence)} reply.md`))
  ) {
    nextSequence += 1;
  }
  return nextSequence;
}

function formatConversationNoteSequence(sequence) {
  return String(sequence).padStart(3, "0");
}

function toVaultRelativePath(vaultRoot, absolutePath) {
  return path.relative(vaultRoot, absolutePath).split(path.sep).join("/");
}

module.exports = {
  readConversationNoteIndex,
  upsertConversationNoteIndex,
  writePromptNote,
  writeReplyNote,
};
