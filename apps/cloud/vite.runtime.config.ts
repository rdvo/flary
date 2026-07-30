import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  plugins: [
    cloudflare({ configPath: ".flue-vite.wrangler.jsonc" }),
  ],
});
