// Puts the AMO icon (design/icon/mascot-blue/icon, 2026-10-26: 第三套 · 钴蓝侧分, its ready-made 开心 icon; it replaced
// the viewfinder, design/icon/viewfinder.svg) where the app ships it: the window icon (PNG), the exe icon (the
// multi-size ICO) and the UI's icon.png. Also the six faces of the 「AMO 娘」 pet (design/icon/mascot-blue/0N-*.png),
// cropped square to what is drawn, for the UI (ui/public/mascot) and the taskbar (app/assets/mascot); cropping and
// scaling run in the installed Edge through Playwright. Run after changing those files:
//   node scripts/make-icons.mjs
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const studio = join(dirname(fileURLToPath(import.meta.url)), "..");
const mascot = join(studio, "design", "icon", "mascot-blue");
const icon = join(mascot, "icon");

copyFileSync(join(icon, "amo-studio-256.png"), join(studio, "packages", "app", "assets", "icon.png"));
copyFileSync(join(icon, "amo-studio.ico"), join(studio, "packages", "app", "assets", "icon.ico"));
copyFileSync(join(icon, "amo-studio-128.png"), join(studio, "packages", "ui", "public", "icon.png"));

const FACE_SIZE = 128;
const faces = readdirSync(mascot).filter((f) => /^0\d-[a-z]+\.png$/.test(f));
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage();
await page.setContent("<html><body style='margin:0'></body></html>");
const outs = [join(studio, "packages", "ui", "public", "mascot"), join(studio, "packages", "app", "assets", "mascot")];
for (const dir of outs) mkdirSync(dir, { recursive: true });
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
  for (const dir of outs) writeFileSync(join(dir, file), Buffer.from(b64, "base64"));
}
await browser.close();
console.log(`icons written: app/assets/icon.png, icon.ico, ui/public/icon.png; ${faces.length} faces at ${FACE_SIZE} px`);
