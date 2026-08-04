import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

const site = process.env.PUBLIC_SITE_URL ?? "https://flary.dev";

export default defineConfig({
  site,
  output: "static",
  redirects: {
    "/docs/getting-started": "/docs/quickstart",
    "/docs/self-hosting": "/docs/deploy",
    "/docs/one-off-agent": "/docs/functions",
    "/docs/prompts": "/docs/functions",
    "/docs/durable-threads": "/docs/threads",
    "/docs/sessions-and-workspaces": "/docs/storage-and-recovery",
    "/docs/workspaces-history": "/docs/storage-and-recovery",
    "/docs/tools-and-mcp": "/docs/tools",
    "/docs/host-neutral-toolsets": "/docs/low-level-hosting",
    "/docs/providers-and-cache": "/docs/connections",
    "/docs/modes-permissions": "/docs/agents",
    "/docs/cloudflare-resources": "/docs/deploy",
    "/docs/production-checklist": "/docs/operations",
    "/docs/channels-and-webhooks": "/docs/clients",
  },
  outDir: ".astro-dist",
  publicDir: "site-public",
  build: {
    format: "directory",
  },
  integrations: [mdx(), react(), sitemap()],
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
