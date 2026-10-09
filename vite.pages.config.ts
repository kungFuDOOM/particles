import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Static build for GitHub Pages: no server, so the tape reads Coinbase's public REST API
 * straight from the browser (src/lib/tape-feed.static.ts).
 *
 *   PAGES_BASE=/particles/ npm run pages:build
 */
const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  root: "pages",
  base: process.env.PAGES_BASE ?? "/",
  publicDir: "../public",
  envDir: "..",
  resolve: {
    alias: [
      { find: "@/lib/tape-feed", replacement: `${src}/lib/tape-feed.static.ts` },
      { find: "@", replacement: src },
    ],
  },
  build: {
    outDir: "../dist-pages",
    emptyOutDir: true,
  },
  plugins: [tailwindcss(), viteReact()],
});
