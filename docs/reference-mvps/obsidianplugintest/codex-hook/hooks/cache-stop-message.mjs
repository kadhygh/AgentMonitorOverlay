import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const cacheRoot = path.join(projectRoot, '.codex', 'cache');
const archiveRoot = path.join(cacheRoot, 'assistant-turns');
const latestFile = path.join(cacheRoot, 'latest-assistant-message.md');
const latestJsonFile = path.join(cacheRoot, 'latest-assistant-message.json');
const errorLogFile = path.join(cacheRoot, 'assistant-turn-errors.log');

try {
  const rawInput = await readStdin();
  const payload = rawInput.trim().length > 0 ? JSON.parse(rawInput) : {};
  const message = normalizeMessage(payload.last_assistant_message);

  if (message) {
    await fs.mkdir(archiveRoot, { recursive: true });

    const capturedAt = new Date().toISOString();
    const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : 'unknown-turn';
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : 'unknown-session';
    const model = typeof payload.model === 'string' ? payload.model : 'unknown-model';
    const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : null;
    const stopHookActive = Boolean(payload.stop_hook_active);

    const record = {
      capturedAt,
      sessionId,
      turnId,
      model,
      hookEventName: payload.hook_event_name ?? 'Stop',
      cwd: payload.cwd ?? null,
      transcriptPath,
      stopHookActive,
      message,
    };

    const archiveStem = `${toFileSafeTimestamp(capturedAt)}-${sanitizeFilePart(turnId)}`;
    const archiveMdPath = path.join(archiveRoot, `${archiveStem}.md`);
    const archiveJsonPath = path.join(archiveRoot, `${archiveStem}.json`);

    await Promise.all([
      fs.writeFile(archiveMdPath, renderMarkdown(record), 'utf8'),
      fs.writeFile(archiveJsonPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8'),
      fs.writeFile(latestFile, renderMarkdown(record), 'utf8'),
      fs.writeFile(latestJsonFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8'),
    ]);
  }

  process.stdout.write('{"continue":true}\n');
} catch (error) {
  await fs.mkdir(cacheRoot, { recursive: true });
  const errorText = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  const line = `[${new Date().toISOString()}] ${errorText}\n`;
  await fs.appendFile(errorLogFile, line, 'utf8');
  process.stdout.write('{"continue":true}\n');
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function normalizeMessage(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\r\n?/g, '\n').trim();
}

function toFileSafeTimestamp(value) {
  return value.replace(/[:.]/g, '-');
}

function sanitizeFilePart(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'turn';
}

function renderMarkdown(record) {
  const lines = [
    '# Cached Codex Reply',
    '',
    `- captured_at: ${record.capturedAt}`,
    `- session_id: ${record.sessionId}`,
    `- turn_id: ${record.turnId}`,
    `- model: ${record.model}`,
    `- hook_event_name: ${record.hookEventName}`,
    `- stop_hook_active: ${record.stopHookActive}`,
  ];

  if (record.cwd) {
    lines.push(`- cwd: ${record.cwd}`);
  }

  if (record.transcriptPath) {
    lines.push(`- transcript_path: ${record.transcriptPath}`);
  }

  lines.push('', '---', '', record.message, '');
  return lines.join('\n');
}
