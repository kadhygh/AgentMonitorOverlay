// Only test account credentials from android-fixture; never copy a person's account to the emulator.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dpapi } from '@amo-studio/account';

const readyPath = process.argv[2];
if (!readyPath) throw new Error('Usage: node scripts/android-provision.mjs <fixture-ready.json> [emulator-5580]');
const ready = JSON.parse(readFileSync(readyPath, 'utf8'));
const credentials = JSON.parse(await dpapi.unprotect(readFileSync(ready.credentialsFile, 'utf8')));
if (!credentials.name.startsWith('android-')) throw new Error('Only Android fixture accounts may be provisioned');
const adb = join(process.env.ANDROID_HOME || join(process.env.LOCALAPPDATA, 'Android', 'Sdk'), 'platform-tools', 'adb.exe');
const serial = process.argv[3] || 'emulator-5580';
function run(args) {
  const result = spawnSync(adb, ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`adb ${args[0]} failed: ${result.stderr}`);
}
const local = join(ready.root, 'mobile-test.json');
try {
  writeFileSync(local, JSON.stringify({ server: ready.server, name: credentials.name, password: credentials.password, file: 'sample.txt', fileContains: 'Android fixture text', control: ready.controlUrl }), { mode: 0o600 });
  const port = new URL(ready.server).port;
  if (new URL(ready.server).hostname === '127.0.0.1') run(['reverse', `tcp:${port}`, `tcp:${port}`]);
  if (ready.controlUrl) { const controlPort = new URL(ready.controlUrl).port; run(['reverse', `tcp:${controlPort}`, `tcp:${controlPort}`]); }
  run(['push', local, '/data/local/tmp/amo-android-test.json']);
  run(['shell', 'chmod', '600', '/data/local/tmp/amo-android-test.json']);
  console.log('Test credentials provisioned to emulator; remove /data/local/tmp/amo-android-test.json after testing.');
} finally { try { unlinkSync(local); } catch {} }
