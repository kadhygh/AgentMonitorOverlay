import esbuild from "esbuild";
import builtins from "builtin-modules";

const prod = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const context = await esbuild.context({
  banner: {
    js: "/* Agent Monitor Overlay Obsidian plugin spike. */",
  },
  bundle: true,
  entryPoints: ["src/main.ts"],
  external: ["obsidian", "electron", "@codemirror/*", ...builtins],
  format: "cjs",
  logLevel: "info",
  minify: prod,
  outfile: "dist/main.js",
  platform: "browser",
  sourcemap: prod ? false : "inline",
  target: "es2022",
});

if (watch) {
  await context.watch();
  console.log("Watching Obsidian plugin source...");
} else {
  await context.rebuild();
  await context.dispose();
}
