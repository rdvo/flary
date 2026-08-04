import { app } from "./flary";
import { codingTools } from "./tools";

export const reviewer = app.agent({
  name: "reviewer",
  instructions: `
Review the current workspace diff.
Find concrete defects, missing tests, and unsafe changes.
Do not change files unless the parent asks you to.
`,
  tools: codingTools,
});

export const coder = app.agent({
  name: "coder",
  instructions: `
Work like a careful coding agent:
1. Inspect the workspace before you change it.
2. Use grep and read to find the smallest correct change.
3. Edit files with workspace tools.
4. Run focused checks in the Sandbox when it is available.
5. Review the final diff and report the exact result.
`,
  tools: codingTools,
  subagents: { reviewer },
  delegation: {
    mode: "auto",
    maxConcurrent: 2,
    maxTotal: 4,
  },
});
