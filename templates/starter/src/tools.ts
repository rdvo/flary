import { z } from "flary";

import { app } from "./flary";

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
  policy: { operation: "read", capabilities: ["docs.read"] },
  run: ({ query }) => [
    {
      title: `Documentation result for ${query}`,
      url: "https://example.com/docs",
      excerpt: "Replace this function with your documentation search.",
    },
  ],
});

export const tools = app.tools({ searchDocs });
