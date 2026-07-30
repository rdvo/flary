import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

const site = process.env.PUBLIC_SITE_URL ?? "https://flary.dev";

export default defineConfig({
  site,
  output: "static",
  outDir: ".astro-dist",
  publicDir: "site-public",
  build: {
    format: "directory",
  },
  integrations: [react(), sitemap()],
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "viewport",
  },
  vite: {
    server: {
      proxy: {
        "/api": "http://127.0.0.1:8788",
        "/health": "http://127.0.0.1:8788",
      },
    },
  },
});
