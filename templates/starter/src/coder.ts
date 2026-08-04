import { app } from "./flary";
import { tools } from "./tools";

export const coder = app.agent({
  name: "coder",
  instructions: "Help the user complete work. Use tools when they are useful.",
  tools,
});
