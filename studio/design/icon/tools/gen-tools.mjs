// Final AMO tool icons (user 2026-10-28: 方向一「取景框」): writes studio/design/icon/tools/<tool>.svg (32 px and up) and
// <tool>-small.svg (16–24 px). Usage: node design/icon/tools/gen-tools.mjs [outDir] [variant-json], then node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const out = process.argv[2] ?? `${dirname(fileURLToPath(import.meta.url))}/`;
const V = { ink: 56, halo: 96, arm: 124, tile: 100, rx: 72, k: 0.95, sw: 44, ...(process.argv[3] ? JSON.parse(process.argv[3]) : {}) };
mkdirSync(out, { recursive: true });
const INK = "#22201c", PAPER = "#fbfaf7";
const TOOLS = {
  platform: { name: "AMO 平台", fill: "#c96442", glyph: PAPER },
  studio:   { name: "AMO Studio", fill: "#2f5a92", glyph: PAPER },
  reviewer: { name: "AMO Reviewer", fill: "#2e7d5b", glyph: PAPER },
  notes:    { name: "AMO 便签", fill: "#e3a82b", glyph: INK },
  relay:    { name: "AMO 中转", fill: "#6a58a8", glyph: PAPER },
};

// Glyphs around (0,0) in a 240-unit box; sw = stroke width in those units. `small` drops what 16 px cannot show.
function glyph(tool, c, sw, small) {
  const st = (w = sw) => `fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
  const s = st();
  switch (tool) {
    case "studio": // the family face
      return small
        ? `<circle cx="-54" cy="-26" r="${sw * 0.95}" fill="${c}"/><circle cx="54" cy="-26" r="${sw * 0.95}" fill="${c}"/><path d="M-60 50 Q0 90 60 50" ${s}/>`
        : `<circle cx="-52" cy="-22" r="${sw * 0.95}" fill="${c}"/><circle cx="52" cy="-22" r="${sw * 0.95}" fill="${c}"/><path d="M-62 46 Q0 92 62 46" ${s}/>`;
    case "reviewer": // a lens: review and inspect
      return `<circle cx="-22" cy="-22" r="${small ? 66 : 70}" ${s}/><path d="M30 30 L92 92" ${st(sw * 1.25)}/>`;
    case "notes": // a sheet with a folded corner (the lines only when there is room)
      return `<path d="M-74 -96 H74 Q96 -96 96 -74 V36 L36 96 H-74 Q-96 96 -96 74 V-74 Q-96 -96 -74 -96 Z" ${s}/><path d="M96 36 H52 Q36 36 36 52 V96" ${s}/>` + (small ? `<path d="M-44 -30 H44" ${s}/>` : `<path d="M-50 -38 H50 M-50 10 H14" ${st(sw * 0.8)}/>`);
    case "platform": // a shelf of tools with one free slot
      return `<rect x="-104" y="-104" width="90" height="90" rx="22" fill="${c}"/><rect x="-104" y="14" width="90" height="90" rx="22" fill="${c}"/><rect x="14" y="14" width="90" height="90" rx="22" fill="${c}"/><path d="M59 -100 V-18 M18 -59 H100" ${s}/>`;
    case "relay": // hand over and back
      return `<path d="M-92 -44 H82 M46 -82 L86 -44 L46 -6" ${s}/><path d="M92 50 H-82 M-46 12 L-86 50 L-46 88" ${s}/>`;
  }
}

// 32 px and up: the family's ink corners with a paper halo (so they read on a dark taskbar), the tool's tile in the middle.
const corners = `<g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <g stroke="${PAPER}" stroke-width="44" opacity="0.9"><path d="M80 168 V96 Q80 80 96 80 H168"/><path d="M344 80 H416 Q432 80 432 96 V168"/><path d="M432 344 V416 Q432 432 416 432 H344"/><path d="M168 432 H96 Q80 432 80 416 V344"/></g>
    <g stroke="${INK}" stroke-width="28"><path d="M80 168 V96 Q80 80 96 80 H168"/><path d="M344 80 H416 Q432 80 432 96 V168"/><path d="M432 344 V416 Q432 432 416 432 H344"/><path d="M168 432 H96 Q80 432 80 416 V344"/></g>
  </g>`;

// 16–24 px: the corners pushed to the edge, shorter and much heavier, with a wider halo; the tile and glyph larger.
function smallCorners() {
  const e = V.halo / 2, a = V.arm, r = 34, E = 512 - e;
  const paths = [`M${e} ${a} V${e + r} Q${e} ${e} ${e + r} ${e} H${a}`, `M${512 - a} ${e} H${E - r} Q${E} ${e} ${E} ${e + r} V${a}`, `M${E} ${512 - a} V${E - r} Q${E} ${E} ${E - r} ${E} H${512 - a}`, `M${a} ${E} H${e + r} Q${e} ${E} ${e} ${E - r} V${512 - a}`].map((d) => `<path d="${d}"/>`).join("");
  return `<g fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="${PAPER}" stroke-width="${V.halo}">${paths}</g><g stroke="${INK}" stroke-width="${V.ink}">${paths}</g></g>`;
}

for (const [id, t] of Object.entries(TOOLS)) {
  writeFileSync(out + `${id}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="24 24 464 464" width="512" height="512">
  <!-- ${t.name} (2026-10-28, the user's pick 方向一「取景框」): the family's ink corners, the tool's colour and glyph in the
       middle. Used at 32 px and up; ${id}-small.svg below that. Made by scripts/make-icons.mjs into the program's files. -->
  ${corners}
  <rect x="140" y="140" width="232" height="232" rx="62" fill="${t.fill}"/>
  <g transform="translate(256 256) scale(0.78)">${glyph(id, t.glyph, 34, false)}</g>
</svg>
`);
  const T = V.tile, W = 512 - 2 * T;
  writeFileSync(out + `${id}-small.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <!-- ${t.name}, 16–24 px cut of ${id}.svg: corners at the edge, shorter and heavier, with a wide paper halo so they still
       show on a dark taskbar; the tile and glyph larger, small details dropped. -->
  ${smallCorners()}
  <rect x="${T}" y="${T}" width="${W}" height="${W}" rx="${V.rx}" fill="${t.fill}"/>
  <g transform="translate(256 256) scale(${(W / 264) * V.k})">${glyph(id, t.glyph, V.sw, true)}</g>
</svg>
`);
}
console.log("ok", JSON.stringify(V));
