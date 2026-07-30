import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: ".astro-dist",
  build: {
    emptyOutDir: false,
  },
  plugins: [cloudflare({ configPath: "wrangler.site.jsonc" })],
});
