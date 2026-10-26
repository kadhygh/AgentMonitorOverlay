import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The AMO 中转 client's content (plans/relay.md): the desktop shell downloads this build from the service and loads it
// from disk (hot update); a browser opens the same build at the service's /app/. Relative paths for both.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
});
