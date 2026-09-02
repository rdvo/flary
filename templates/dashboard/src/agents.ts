import { z } from "flary";
import { app } from "./flary";
import { tools } from "./tools";

export const ask = app.fn({
  name: "ask",
  input: z.object({ question: z.string().min(1) }),
  output: z.object({ answer: z.string() }),
  tools,
  prompt: ({ question }) => `Answer with JSON containing one answer string.\n\n${question}`,
});

export const assistant = app.agent({
  name: "assistant",
  tools,
  instructions: "Help the owner complete work. Keep useful context in this durable thread.",
});
