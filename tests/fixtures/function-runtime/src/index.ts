import { z, flary } from "../../../../src/index.ts";

const app = flary({
  name: "fixture",
  runtime: "local",
});

export const support = app.fn({
  name: "support",
  input: z.object({ question: z.string() }),
  output: z.object({ answer: z.string() }),
  prompt: ({ question }) => question,
});

export const native = app.fn({
  name: "native",
  input: z.object({ value: z.number() }),
  output: z.object({ value: z.number() }),
  run: ({ value }) => ({ value }),
});

export const functions = { support, native };
export default app.serve(functions);
