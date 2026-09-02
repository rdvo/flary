import { z } from "zod";
import {
  toolTaskInputSchema,
  type ToolHandler,
  type ToolRegistryEntry,
  type ToolTask,
  type ToolTaskInput,
} from "./types.js";

const functionValueSchema = z.custom<(...args: never[]) => unknown>(
  (value) => typeof value === "function",
  { message: "Expected a function" },
);

export function parseToolHandler(value: unknown): ToolHandler {
  return functionValueSchema.parse(value) as ToolHandler;
}

export function normalizeToolTask(input: ToolTaskInput | ToolTask): ToolTask {
  const parsed = toolTaskInputSchema.parse(input);
  const operation = parsed.operation ?? parsed.kind ?? parsed.type ?? "read";
  const execute = parsed.execute === undefined ? undefined : parseToolHandler(parsed.execute);
  const handler = parsed.handler === undefined ? undefined : parseToolHandler(parsed.handler);

  return {
    ...parsed,
    operation,
    dependsOn: [...new Set(parsed.dependsOn)],
    requiresApproval: parsed.requiresApproval ?? false,
    execute,
    handler,
  };
}

export function parseToolTasks(inputs: readonly (ToolTaskInput | ToolTask)[]): ToolTask[] {
  const parsed = z.array(toolTaskInputSchema).parse(inputs);
  const ids = new Set<string>();
  const issues: z.ZodIssue[] = [];

  for (const [index, task] of parsed.entries()) {
    if (ids.has(task.id)) {
      issues.push({
        code: z.ZodIssueCode.custom,
        path: [index, "id"],
        message: `Duplicate task ID '${task.id}'`,
      });
    }
    ids.add(task.id);
  }

  for (const [index, task] of parsed.entries()) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        issues.push({
          code: z.ZodIssueCode.custom,
          path: [index, "dependsOn"],
          message: `Unknown dependency '${dependency}'`,
        });
      }
    }
  }

  if (issues.length > 0) {
    throw new z.ZodError(issues);
  }

  return parsed.map(normalizeToolTask);
}

export interface NormalizedToolDefinition {
  readonly execute: ToolHandler;
  readonly operation?: "read" | "write";
  readonly resourceKey?: string | ((task: ToolTask) => string | undefined);
  readonly requiresApproval?: boolean;
  readonly concurrencyKey?: string;
}

export function normalizeToolDefinition(
  entry: ToolRegistryEntry | unknown,
): NormalizedToolDefinition {
  if (typeof entry === "function") {
    return { execute: parseToolHandler(entry) };
  }

  if (!entry || typeof entry !== "object") {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: [],
        message: "A tool definition must be a function or an object",
      },
    ]);
  }

  const candidate = entry as Record<string, unknown>;
  const execute = parseToolHandler(candidate.execute);
  const operation = candidate.operation;
  if (operation !== undefined && operation !== "read" && operation !== "write") {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["operation"],
        message: "operation must be 'read' or 'write'",
      },
    ]);
  }

  const resourceKey = candidate.resourceKey;
  if (
    resourceKey !== undefined &&
    typeof resourceKey !== "string" &&
    typeof resourceKey !== "function"
  ) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["resourceKey"],
        message: "resourceKey must be a string or a function",
      },
    ]);
  }

  const concurrencyKey = candidate.concurrencyKey;
  if (concurrencyKey !== undefined && typeof concurrencyKey !== "string") {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["concurrencyKey"],
        message: "concurrencyKey must be a string",
      },
    ]);
  }

  const requiresApproval = candidate.requiresApproval;
  if (requiresApproval !== undefined && typeof requiresApproval !== "boolean") {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["requiresApproval"],
        message: "requiresApproval must be a boolean",
      },
    ]);
  }

  return {
    execute,
    operation: operation as "read" | "write" | undefined,
    resourceKey: resourceKey as string | ((task: ToolTask) => string | undefined) | undefined,
    requiresApproval: requiresApproval as boolean | undefined,
    concurrencyKey: concurrencyKey as string | undefined,
  };
}
