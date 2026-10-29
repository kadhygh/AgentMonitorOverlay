// The icons the programs ship. Uses the installed Edge through Playwright; run after changing a source:
//   node scripts/make-icons.mjs          every program's icon, and 「AMO 娘」's
//   node scripts/make-icons.mjs --relay  only AMO 中转's (its shell is released on its own)
// - Each tool's own icon (2026-10-28, the user's pick 方向一「取景框」): design/icon/tools/<tool>.svg is the full drawing,
//   used from 32 px up; <tool>-small.svg is the 16–24 px cut (heavier corners at the edge, a bigger tile). Per tool:
//   - Studio: the UI's icon.svg (ui/public: favicon, Focus, the running mark in the conversation), the window icon
//     (app/assets/icon.png), the tray icon-16…32.png (2026-10-29) and the exe icon (app/assets/icon.ico);
//     design/icon/viewfinder-512.png (an e2e test picture).
//   - Reviewer: reviewer/assets/icon.png (its windows when it runs on its own) and icon.ico (its exe).
//   - 便签: notes/assets/icon.png and icon-16…64.png (window, tray, and package-portable.mjs builds its exe icon from them).
//   - 平台: platform/assets/icon.png, icon-16…32.png (tray) and icon.ico.
//   - 中转: relay-app/assets (window PNG, tray icon-16…32.png, exe ICO, the loader's SVG) and relay-ui/src/icon.svg;
//     its tray PNGs also as platform/assets/relay-16…32.png (the platform's tray shows 中转's icon while something waits).
//   ICO files carry 16–256 px, the small cut up to 24 px.
// - 「AMO 娘」 (2026-10-26, used while she is the 桌宠): the blue mascot's ready-made icon (design/icon/mascot-blue/icon)
//   and her six faces (design/icon/mascot-blue/0N-*.png) cropped square to what is drawn, for the UI (ui/public/mascot)
//   and the window icon (app/assets/mascot). Not touched by the tool icons above.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const studio = join(dirname(fileURLToPath(import.meta.url)), "..");
const relayOnly = process.argv.includes("--relay");
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const SMALL_UP_TO = 24;
const TRAY_SIZES = [16, 20, 24, 32];

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage();
async function render(size, svg) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace(/width="512" height="512"/, `width="${size}" height="${size}"`)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

/** A tool's two drawings; png(size) picks the small cut up to 24 px. */
function tool(name) {
  const src = (f) => join(studio, "design", "icon", "tools", f);
  const full = readFileSync(src(`${name}.svg`), "utf8");
  const small = readFileSync(src(`${name}-small.svg`), "utf8");
  return { svgPath: src(`${name}.svg`), png: (size) => render(size, size <= SMALL_UP_TO ? small : full) };
}

// ICO: a header, one directory entry per image, then the PNG data (Windows Vista and later read PNG entries).
async function ico(t) {
  const images = [];
  for (const size of ICO_SIZES) images.push({ size, data: await t.png(size) });
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
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const assets = (pkg) => {
  const dir = join(studio, "packages", pkg, "assets");
  mkdirSync(dir, { recursive: true });
  return dir;
};
async function trayPngs(t, dir) {
  for (const size of TRAY_SIZES) writeFileSync(join(dir, `icon-${size}.png`), await t.png(size));
}

// AMO 中转.
const relay = tool("relay");
const relayAssets = assets("relay-app");
writeFileSync(join(relayAssets, "icon.png"), await relay.png(256));
writeFileSync(join(relayAssets, "icon.ico"), await ico(relay));
await trayPngs(relay, relayAssets);
// The platform's tray turns into 中转's icon while something waits there (2026-10-29, relay-attention.ts): its own copy.
for (const size of TRAY_SIZES) copyFileSync(join(relayAssets, `icon-${size}.png`), join(assets("platform"), `relay-${size}.png`));
copyFileSync(relay.svgPath, join(studio, "packages", "relay-ui", "src", "icon.svg"));
copyFileSync(relay.svgPath, join(relayAssets, "icon.svg"));
if (relayOnly) {
  await browser.close();
  console.log(`AMO 中转 icons written: ${ICO_SIZES.join(", ")} px`);
  process.exit(0);
}

// AMO Studio.
const studioIcon = tool("studio");
writeFileSync(join(studio, "design", "icon", "viewfinder-512.png"), await studioIcon.png(512));
writeFileSync(join(assets("app"), "icon.png"), await studioIcon.png(256));
writeFileSync(join(assets("app"), "icon.ico"), await ico(studioIcon));
await trayPngs(studioIcon, assets("app"));
copyFileSync(studioIcon.svgPath, join(studio, "packages", "ui", "public", "icon.svg"));

// AMO Reviewer.
const reviewer = tool("reviewer");
writeFileSync(join(assets("reviewer"), "icon.png"), await reviewer.png(256));
writeFileSync(join(assets("reviewer"), "icon.ico"), await ico(reviewer));

// AMO 便签: the window icon and one PNG per size (tray; package-portable.mjs makes its exe icon from them).
const notes = tool("notes");
writeFileSync(join(assets("notes"), "icon.png"), await notes.png(256));
for (const size of [16, 20, 24, 32, 48, 64]) writeFileSync(join(assets("notes"), `icon-${size}.png`), await notes.png(size));

// AMO 平台.
const platform = tool("platform");
writeFileSync(join(assets("platform"), "icon.png"), await platform.png(256));
writeFileSync(join(assets("platform"), "icon.ico"), await ico(platform));
await trayPngs(platform, assets("platform"));

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
console.log(`icons written for Studio, Reviewer, 便签, 平台, 中转 (${ICO_SIZES.join(", ")} px; 16–24 px from the small cut); 「AMO 娘」 icon and ${faces.length} faces`);
