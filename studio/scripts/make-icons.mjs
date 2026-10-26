// Puts the AMO icon (design/icon/mascot-blue/icon, 2026-10-26: 第三套 · 钴蓝侧分, its ready-made 开心 icon; it replaced
// the viewfinder, design/icon/viewfinder.svg) where the app ships it: the window icon (PNG), the exe icon (the
// multi-size ICO) and the UI's icon.png. Run after changing those files:
//   node scripts/make-icons.mjs
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const studio = join(dirname(fileURLToPath(import.meta.url)), "..");
const icon = join(studio, "design", "icon", "mascot-blue", "icon");

copyFileSync(join(icon, "amo-studio-256.png"), join(studio, "packages", "app", "assets", "icon.png"));
copyFileSync(join(icon, "amo-studio.ico"), join(studio, "packages", "app", "assets", "icon.ico"));
copyFileSync(join(icon, "amo-studio-128.png"), join(studio, "packages", "ui", "public", "icon.png"));
console.log("icons written: app/assets/icon.png, app/assets/icon.ico, ui/public/icon.png");
