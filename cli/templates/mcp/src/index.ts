import { z } from "zod";
import { MCP } from "flary";

// Initialize MCP instance
const app = new MCP({
  name: "mcp-server", // This will be replaced by the CLI with the project name
  description: "A simple MCP server",
  version: "1.0.0",
  auth: {
    type: "bearer",
    token: "your-secret-token", // Change this in production
  },
});

// Example tool
const sumSchema = z
  .object({
    a: z.number().describe("The first number to add"),
    b: z.number().describe("The second number to add"),
  })
  .describe("Calculate the sum of two numbers");

async function calculateSum({ a, b }: z.input<typeof sumSchema>) {
  return a + b;
}
calculateSum.schema = sumSchema;

// Register the tool
app.tool("calculate_sum", calculateSum);

// Export the app and McpObject for Durable Objects
export default app;
export const { McpObject } = app;
