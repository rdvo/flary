import { defineConfig } from "@flue/cli/config";

export default defineConfig({
  target: "cloudflare",
  root: ".",
  output: "./dist",
});
