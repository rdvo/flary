import { cloudflare } from "@cloudflare/vite-plugin";
import codemode from "@cloudflare/codemode/vite";
import { flary as flaryVite } from "flary/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    flaryVite({ functionsEntry: "./src/index.ts" }),
    codemode(),
    cloudflare({ configPath: ".flue-vite.wrangler.jsonc" }),
  ],
});
