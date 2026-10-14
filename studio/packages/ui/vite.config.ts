import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { host: "127.0.0.1", port: 47901, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
  // The highlight worker loads grammars on demand: ES module workers keep those imports split.
  worker: { format: "es" },
});
