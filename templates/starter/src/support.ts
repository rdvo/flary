import { z } from "flary";

import { app } from "./flary";
import { supportTools } from "./tools";

export const support = app.fn({
  input: z.object({ question: z.string().min(1) }),
  output: z.object({
    answer: z.string(),
    sources: z.array(z.string().url()),
  }),
  tools: supportTools,
  prompt: ({ question }) => `
Answer the question. Use the documentation tool when product facts are needed.
Return JSON with an answer and a sources array.

Question: ${question}
`,
});
