import { z } from "flary";
import { app } from "./flary";
import { generated } from "./flary.generated";

export const remember = app.fn({
  description: "Save a short note in this tool result",
  input: z.object({ note: z.string().min(1) }),
  output: z.object({ saved: z.boolean(), note: z.string() }),
  run: ({ note }) => ({ saved: true, note }),
});

const optional = {
  ...(generated.features.mcp
    ? {
        connections: app.mcp({
          namespace: "connections",
          connection: "dashboard-mcp",
        }),
      }
    : {}),
  ...(generated.features.browser ? { browser: app.browser({ profile: "thread" }) } : {}),
  ...(generated.features.sandbox
    ? { shell: app.sandbox({ network: "restricted", sleepAfter: "10m" }) }
    : {}),
};
export const tools = app.tools({ remember, ...optional });
