import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { host: "127.0.0.1", port: 47901, strictPort: true },
  // Three pages (2026-10-23): Studio (index.html), the AMO 便签's (notes.html) and the AMO Reviewer's (reviewer.html),
  // each with only what it needs.
  build: { outDir: "dist", emptyOutDir: true, rolldownOptions: { input: { main: "index.html", notes: "notes.html", reviewer: "reviewer.html" } } },
  // The highlight worker loads grammars on demand: ES module workers keep those imports split.
  worker: { format: "es" },
});
