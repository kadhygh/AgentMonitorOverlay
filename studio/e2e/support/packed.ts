import { createRequire } from "node:module";
import { join, resolve } from "node:path";

// AMO_E2E_APP=<folder of packed programs> (2026-11-03, plans/package-slim.md): the specs launch the packed exe
// (<folder>\AMO Studio\AMO Studio.exe …) instead of Electron with a package's dist/main.js, so a packed build can be
// checked with the same specs (npm run package:platform -- release/x, then AMO_E2E_APP=release/x npx playwright test …).
// Unset: the dev layout, as before.

const require = createRequire(import.meta.url);
const electronPath = require("electron") as unknown as string;

/** The programs a packed folder has, by their dev main's package. */
const PACKED = { app: "AMO Studio", notes: "AMO Notes", reviewer: "AMO Reviewer", platform: "AMO Platform", "relay-app": "AMO Relay" } as const;

/** The packed programs' folder, when the run checks a packed build. */
export const packedApp = process.env.AMO_E2E_APP ? resolve(process.env.AMO_E2E_APP) : null;

/** What to launch for a program: Electron with `devMain`, or the packed exe of AMO_E2E_APP (its launcher runs the program). */
export function programLaunch(program: keyof typeof PACKED, devMain: string): { executablePath: string; args: string[] } {
  if (!packedApp) return { executablePath: electronPath, args: [devMain] };
  const name = PACKED[program];
  return { executablePath: join(packedApp, name, `${name}.exe`), args: [] };
}
