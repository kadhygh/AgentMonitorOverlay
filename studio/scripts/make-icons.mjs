// Renders the AMO mascot (design/icon/mascot-purple, 2026-10-26: 第一套 · 紫色短发, the 开心 face; it replaced the
// viewfinder, design/icon/viewfinder.svg) into the icons the app ships: the UI's icon.png, the window icon (PNG) and
// the exe icon (ICO with PNG images, 16–256 px). Scales in the installed Edge through Playwright, halving step by step
// so small sizes stay smooth; run after changing the source:
//   node scripts/make-icons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const studio = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(studio, "design", "icon", "mascot-purple", "02-happy.png");
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage();
await page.setContent("<html><body style='margin:0'></body></html>");
const dataUrl = `data:image/png;base64,${readFileSync(source).toString("base64")}`;

/** The source at `size` px square, as PNG bytes. */
async function png(size) {
  const b64 = await page.evaluate(
    async ({ dataUrl, size }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      let canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext("2d").drawImage(img, 0, 0);
      while (canvas.width / 2 >= size) {
        const half = document.createElement("canvas");
        half.width = half.height = canvas.width / 2;
        const g = half.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(canvas, 0, 0, half.width, half.height);
        canvas = half;
      }
      const out = document.createElement("canvas");
      out.width = out.height = size;
      const g = out.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(canvas, 0, 0, size, size);
      return out.toDataURL("image/png").split(",")[1];
    },
    { dataUrl, size },
  );
  return Buffer.from(b64, "base64");
}

writeFileSync(join(studio, "packages", "app", "assets", "icon.png"), await png(256));
writeFileSync(join(studio, "packages", "ui", "public", "icon.png"), await png(128));

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
console.log(`icons written: ${ICO_SIZES.join(", ")} px`);
