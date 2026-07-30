import { compilePrompt } from "flary/prompts";

export function createSupportPrompt(source: string, input: {
  customer: { name: string };
  question: string;
}) {
  return compilePrompt(
    {
      path: "prompts/support/answer.prompt.md",
      content: source,
    },
    {
      callerModel: "openai/gpt-5",
      values: input,
    },
  );
}
