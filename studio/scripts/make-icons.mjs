// Renders design/icon/viewfinder.svg into the icons the app ships: the UI's icon.svg, the window icon (PNG) and the
// exe icon (ICO with PNG images, 16–256 px). Uses the installed Edge through Playwright; run after changing the SVG:
//   node scripts/make-icons.mjs
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const studio = join(dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = join(studio, "design", "icon", "viewfinder.svg");
const svg = readFileSync(svgPath, "utf8");
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage();
async function png(size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace(/width="512" height="512"/, `width="${size}" height="${size}"`)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

const big = await png(512);
writeFileSync(join(studio, "design", "icon", "viewfinder-512.png"), big);
writeFileSync(join(studio, "packages", "app", "assets", "icon.png"), await png(256));

// ICO: a header, one directory entry per image, then the PNG data (Windows Vista and later read PNG entries).
const images = [];
for (const size of ICO_SIZES) images.push({ size, data: await png(size) });
await browser.close();
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const entries = images.map(({ size, data }) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0);
  e.writeUInt8(size >= 256 ? 0 : size, 1);
  e.writeUInt8(0, 2);
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
});
writeFileSync(join(studio, "packages", "app", "assets", "icon.ico"), Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
copyFileSync(svgPath, join(studio, "packages", "ui", "public", "icon.svg"));
console.log(`icons written: ${ICO_SIZES.join(", ")} px`);
