import { defineConfig } from "@flue/cli/config";
import { defineConfig as defineViteConfig } from "vite";

export default defineConfig({
  target: "cloudflare",
  root: ".",
  output: "./dist/runtime",
});

export const vite = defineViteConfig({
  publicDir: false,
});
