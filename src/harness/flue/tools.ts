import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";

import type { LazyToolRuntime } from "../tools/runtime";
import { waitForUserInput } from "../tools/user-input";
import {
  UserInputQuestionSchema,
  UserInputRequestSchema,
  UserInputResponseSchema,
  type UserInputQuestion,
  type UserInputRequest,
  type UserInputResponse,
} from "../contracts/user-input";
import type { JsonValue } from "../contracts/common";

export const FLARY_LAZY_TOOL_INSTRUCTIONS = [
  "Use tool_search to find tools by purpose instead of guessing tool names.",
  "Use tool_describe only when you need one tool's input schema.",
  "Use tool_batch for independent calls so reads can run in parallel.",
  "Use tool_call for one call. Every write needs a stable idempotency key.",
].join(" ");

export interface FlueUserInputToolOptions {
  threadKey: string;
  createRequest(input: {
    questions: UserInputQuestion[];
  }): Promise<UserInputRequest> | UserInputRequest;
  waitForResponse?: (
    request: UserInputRequest,
  ) => Promise<UserInputResponse>;
}

/**
 * Expose a fixed, small tool surface to the model.
 *
 * Application tools stay in the private catalog. Their schemas enter the
 * conversation only after Tool Search or Tool Describe returns them.
 */
export function createFlueLazyTools(
  runtime: LazyToolRuntime,
): ToolDefinition[] {
  const search = defineTool({
    name: "tool_search",
    description:
      "Search available tools by name, purpose, tag, or capability. Tool schemas are loaded only when needed.",
    input: v.object({
      query: v.string(),
      maxResults: v.optional(v.number()),
    }),
    async run({ input }) {
      return toJson(await runtime.search({
        query: input.query,
        limit: Math.max(1, Math.min(20, input.maxResults ?? 5)),
      }));
    },
  });

  const describe = defineTool({
    name: "tool_describe",
    description:
      "Load the input schema and policy for one tool returned by tool_search.",
    input: v.object({ id: v.string() }),
    async run({ input }) {
      const loaded = await runtime.describe(input.id);
      if (!loaded) throw new Error(`Tool not found: ${input.id}`);
      return toJson(loaded);
    },
  });

  const call = defineTool({
    name: "tool_call",
    description:
      "Call one previously discovered tool. Writes need an idempotency key and can require user approval.",
    input: v.object({
      id: v.string(),
      arguments: v.optional(v.record(v.string(), v.unknown())),
      callId: v.optional(v.string()),
      idempotencyKey: v.optional(v.string()),
    }),
    async run({ input }) {
      return toJson(await runtime.call({
        id: input.id,
        arguments: input.arguments ?? {},
        ...(input.callId ? { callId: input.callId } : {}),
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      }));
    },
  });

  const batch = defineTool({
    name: "tool_batch",
    description:
      "Run independent tool calls together. Reads run in parallel. Writes to the same resource run in order.",
    input: v.object({
      calls: v.array(
        v.object({
          id: v.string(),
          arguments: v.optional(v.record(v.string(), v.unknown())),
          callId: v.optional(v.string()),
          idempotencyKey: v.optional(v.string()),
          dependsOn: v.optional(v.array(v.string())),
        }),
      ),
    }),
    async run({ input }) {
      return toJson(await runtime.batch({
        calls: input.calls.map((item) => ({
          id: item.id,
          arguments: item.arguments ?? {},
          ...(item.callId ? { callId: item.callId } : {}),
          ...(item.idempotencyKey
            ? { idempotencyKey: item.idempotencyKey }
            : {}),
          dependsOn: item.dependsOn ?? [],
        })),
      }));
    },
  });

  return [search, describe, call, batch];
}

/**
 * Create the standard structured user-input tool.
 *
 * Flary owns the schemas and pause/resume protocol. The host persists the
 * request and renders any suitable UI.
 */
export function createFlueRequestUserInputTool(
  options: FlueUserInputToolOptions,
): ToolDefinition {
  return defineTool({
    name: "request_user_input",
    description:
      "Ask the user up to three structured questions and wait for the answer.",
    input: v.object({
      questions: v.array(v.object({
        header: v.string(),
        question: v.string(),
        options: v.array(v.object({
          label: v.string(),
          description: v.string(),
          preview: v.optional(v.string()),
        })),
        multiSelect: v.optional(v.boolean()),
      })),
    }),
    async run({ input }) {
      const questions = UserInputQuestionSchema.array().min(1).max(3).parse(
        input.questions.map((question) => ({
          ...question,
          multiSelect: question.multiSelect ?? false,
        })),
      );
      const request = UserInputRequestSchema.parse(
        await options.createRequest({ questions }),
      );
      const response = options.waitForResponse
        ? await options.waitForResponse(request)
        : await waitForUserInput(options.threadKey, request.id);
      return toJson(UserInputResponseSchema.parse(response));
    },
  });
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
