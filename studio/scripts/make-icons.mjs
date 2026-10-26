// The icons the app ships. Uses the installed Edge through Playwright; run after changing a source:
//   node scripts/make-icons.mjs
// - The app's own: design/icon/viewfinder.svg rendered into the UI's icon.svg, the window icon (PNG) and the exe icon
//   (ICO with PNG images, 16–256 px).
// - 「AMO 娘」 (2026-10-26, used while she is the 桌宠): the blue mascot's ready-made icon (design/icon/mascot-blue/icon)
//   and her six faces (design/icon/mascot-blue/0N-*.png) cropped square to what is drawn, for the UI (ui/public/mascot)
//   and the window icon (app/assets/mascot).
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

// 「AMO 娘」.
const mascot = join(studio, "design", "icon", "mascot-blue");
const uiMascot = join(studio, "packages", "ui", "public", "mascot");
const appMascot = join(studio, "packages", "app", "assets", "mascot");
for (const dir of [uiMascot, appMascot]) mkdirSync(dir, { recursive: true });
copyFileSync(join(mascot, "icon", "amo-studio-128.png"), join(uiMascot, "icon.png"));
copyFileSync(join(mascot, "icon", "amo-studio-256.png"), join(appMascot, "icon.png"));
const FACE_SIZE = 128;
const faces = readdirSync(mascot).filter((f) => /^0\d-[a-z]+\.png$/.test(f));
await page.setContent("<html><body style='margin:0'></body></html>");
for (const file of faces) {
  const dataUrl = `data:image/png;base64,${readFileSync(join(mascot, file)).toString("base64")}`;
  const b64 = await page.evaluate(
    async ({ dataUrl, size }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const src = document.createElement("canvas");
      src.width = img.width;
      src.height = img.height;
      const sg = src.getContext("2d");
      sg.drawImage(img, 0, 0);
      // What is drawn (alpha above a trace), squared around its middle with a little room.
      const { data, width, height } = sg.getImageData(0, 0, img.width, img.height);
      let [x0, y0, x1, y1] = [width, height, 0, 0];
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          if (data[(y * width + x) * 4 + 3] > 8) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      const side = Math.ceil(Math.max(x1 - x0, y1 - y0) * 1.04);
      const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
      let canvas = document.createElement("canvas");
      canvas.width = canvas.height = side;
      canvas.getContext("2d").drawImage(src, cx - side / 2, cy - side / 2, side, side, 0, 0, side, side);
      while (canvas.width / 2 >= size) {
        const half = document.createElement("canvas");
        half.width = half.height = Math.round(canvas.width / 2);
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
    { dataUrl, size: FACE_SIZE },
  );
  for (const dir of [uiMascot, appMascot]) writeFileSync(join(dir, file), Buffer.from(b64, "base64"));
}
await browser.close();
console.log(`icons written: ${ICO_SIZES.join(", ")} px; 「AMO 娘」 icon and ${faces.length} faces`);
