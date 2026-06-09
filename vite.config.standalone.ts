import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds the portable viewer: one self-contained HTML (all JS/CSS inlined) that
// renders an INJECTED diagram with no layout engine — __STANDALONE__ true drops
// the layout worker and elkjs. The main app fetches this as a template and
// injects the manifest + positions on export. Output: dist-standalone/index.html.
export default defineConfig({
  define: { __STANDALONE__: "true" },
  plugins: [react(), viteSingleFile()],
  base: "./",
  build: {
    outDir: "dist-standalone",
    // Inline every asset (no separate files) — viteSingleFile needs this.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000,
  },
});
