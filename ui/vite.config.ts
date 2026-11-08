import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Spec §3.9: the SPA lives under /ui (same origin as /ui/api) and builds
// into dist/ui next to the compiled server.
export default defineConfig({
  plugins: [preact()],
  base: "/ui/",
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
  },
});
