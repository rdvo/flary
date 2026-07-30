import { Hono } from "hono";
import { z } from "zod";

import { createSupportPrompt } from "./flary/support";
import promptSource from "../prompts/support/answer.prompt.md?raw";

type Bindings = {
  APP_ENV: string;
};

const InputSchema = z.object({
  customer: z.object({ name: z.string().min(1) }),
  question: z.string().min(1),
});

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (context) =>
  context.json({
    ok: true,
    service: "flary-agent",
    environment: context.env.APP_ENV,
  }),
);

app.post("/api/agents/support/preview", async (context) => {
  const input = InputSchema.parse(await context.req.json());
  const prompt = await createSupportPrompt(promptSource, input);
  return context.json(prompt);
});

export default app;
