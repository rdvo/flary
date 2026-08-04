import { z } from "flary";

import { app } from "./flary";
import { generated } from "./flary.generated";

export const searchDocs = app.fn({
  description: "Search the product documentation",
  input: z.object({ query: z.string().min(1) }),
  output: z.array(
    z.object({
      title: z.string(),
      url: z.string().url(),
      excerpt: z.string(),
    }),
  ),
  run: ({ query }) => [
    {
      title: `Documentation result for ${query}`,
      url: "https://example.com/docs",
      excerpt: "Replace this function with your documentation search.",
    },
  ],
});

const optionalTools = {
  ...(generated.features.mcp
    ? {
        github: app.mcp({
          namespace: "github",
          connection: "github",
          url: "https://api.githubcopilot.com/mcp/readonly",
        }),
      }
    : {}),
  ...(generated.features.browser
    ? { browser: app.browser({ profile: "thread" }) }
    : {}),
  ...(generated.features.sandbox
    ? { shell: app.sandbox({ network: "restricted", sleepAfter: "10m" }) }
    : {}),
};

/** Tools for finite support functions. */
export const supportTools = app.tools({ searchDocs });

/**
 * A complete coding workspace.
 *
 * app.workspace() supplies durable list, stat, glob, grep, read, diff,
 * write, edit, batch-edit, move, delete, and Git tools. app.sandbox()
 * supplies Linux commands and durable processes when that feature is enabled.
 */
export const codingTools = app.tools({
  workspace: app.workspace({ branch: "run" }),
  ...optionalTools,
});
