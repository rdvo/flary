import { app } from "./flary";
import { assistantConfig } from "./assistant.generated";
import { supportTools } from "./tools";

export const assistant = app.agent({
  name: "assistant",
  instructions: assistantConfig.systemPrompt,
  tools: supportTools,
});
