// Builds 全景's preview (P1, 2026-11-02): studio/packages/ui/src/panorama/preview.tsx — the same page, layout and
// deck.gl drawing as Studio's 全景 tab, nothing copied — into panorama-preview/ next to this file, plus
// panorama-preview.html, which serve.mjs (http://100.107.87.64:47130/) hands out. Data: panorama-snapshot.json
// (panorama-snapshot.mjs).
//
//   cd studio && node plans/userlayer/panorama-build.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const ui = join(here, "..", "..", "packages", "ui");
const out = join(here, "panorama-preview");

await build({
  configFile: false,
  root: ui,
  base: "./",
  plugins: [react()],
  logLevel: "warn",
  publicDir: false,
  build: {
    outDir: out,
    emptyOutDir: true,
    // PANORAMA_NOMINIFY=1: readable names (for profiling).
    minify: process.env.PANORAMA_NOMINIFY ? false : undefined,
    rolldownOptions: {
      input: { preview: join(ui, "src", "panorama", "preview.tsx") },
      output: { entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js", assetFileNames: "[name][extname]" },
    },
  },
});

writeFileSync(
  join(here, "panorama-preview.html"),
  `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>全景预览</title>
<link rel="stylesheet" href="panorama-preview/preview.css">
<style>
html, body { margin: 0; height: 100%; background: #141b22; overflow: hidden; }
#root { display: flex; height: 100%; }
.pn-preview-msg { margin: auto; color: rgba(222,236,246,.7); font: 13px/1.6 "Segoe UI", "Microsoft YaHei UI", sans-serif; letter-spacing: .2em; }
.pn-preview-tag { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); z-index: 9; padding: 3px 12px; font: 11px/1.6 "Segoe UI", "Microsoft YaHei UI", sans-serif; letter-spacing: .2em; color: rgba(205,222,236,.6); border: 1px solid rgba(230,242,252,.15); border-radius: 2px; pointer-events: none; }
.pn-preview-tag { text-align: center; }
.pn-preview-demo { letter-spacing: .04em; color: #ffc280; max-width: 640px; }
.pn-preview-note { position: fixed; left: 50%; bottom: 60px; transform: translateX(-50%); z-index: 9; padding: 6px 16px; font: 12.5px/1.6 "Segoe UI", "Microsoft YaHei UI", sans-serif; color: #eef5fa; background: rgba(26,36,46,.85); border: 1px solid rgba(230,242,252,.36); border-radius: 2px; }
</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="panorama-preview/preview.js"></script>
</body>
</html>
`,
);
console.log(`built ${out} and panorama-preview.html`);
