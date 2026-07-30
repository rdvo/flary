import {
  defineAgent,
  defineAgentProfile,
  defineTool,
  defineWorkflow,
  type AgentProfile,
  type AgentDefinition,
  type AgentRuntimeConfig,
  type WorkflowDefinition,
} from "@flue/runtime";
import * as v from "valibot";
import { z } from "zod";

import { toFlueThinkingLevel } from "../flue/agent.js";
import { getFunctionState } from "./app.js";
import type { FlaryFunction } from "./types.js";
import {
  ApprovalDecisionSchema,
  type ApprovalDecision,
} from "../contracts/index.js";
import {
  UserInputQuestionSchema,
  UserInputRecordSchema,
  UserInputRequestSchema,
  UserInputResponseSchema,
} from "../contracts/user-input.js";
import {
  createFlueRequestUserInputTool,
} from "../flue/tools.js";
import type {
  ApprovalContinuation,
  ApprovalRecoveryCall,
  ApprovalRecoveryResult,
  ApprovalRecoveryState,
} from "../execution/approval-continuation.js";
import type { UserInputQuestion, UserInputRecord } from "../contracts/user-input.js";

const WorkflowEnvelopeSchema = v.object({
  __flary: v.object({
    runId: v.string(),
    revisionId: v.optional(v.string()),
  }),
  input: v.unknown(),
});

/**
 * Compile one function-first definition into the existing Flue workflow
 * runtime. The returned value is a normal discovered Flue workflow.
 */
export function defineFlaryFunctionWorkflow(
  fn: FlaryFunction<any, any, any>,
): WorkflowDefinition {
  const state = getFunctionState(fn);
  if (!state) {
    throw new Error("The value is not a Flary function");
  }
  const definition = state.definition;
  if (state.mode !== "run") {
    throw new Error("Only native Flary functions compile to Flue workflows");
  }
  const model = definition.model ?? state.app.options.model ?? "openai/gpt-5";
  const timeoutMs = functionTimeoutMs(
    definition.durable?.timeout,
    definition.limits?.timeoutMs,
  );

  const agent = defineAgent(async ({ env, id }): Promise<AgentRuntimeConfig> => {
    const codemodeContinuation = definition.tools
      ? await state.app.approvalContinuationFor(fn, {
          bindings: env,
          runId: id,
        })
      : undefined;
    const userInputTool = createFlaryUserInputTool(env, id);
    const approvalContinuation = combineContinuations(
      codemodeContinuation,
      createFlaryUserInputContinuation(env, id),
    );
    const subagents = await functionSubagents(fn, env, id);
    return {
    model,
    instructions: functionInstructions(fn),
    ...(definition.thinking
      ? { thinkingLevel: toFlueThinkingLevel(definition.thinking as never) }
      : {}),
    durability: {
      maxAttempts: definition.durable?.maxAttempts ?? 10,
      timeoutMs,
    },
    ...(definition.tools || userInputTool
      ? {
          tools: [
            ...(definition.tools
              ? [defineTool({
                  name: "execute",
                  description:
                    "Run bounded TypeScript in Flary's isolated tool runtime. Search and describe tools before calling them.",
                  input: v.object({ code: v.string() }),
                  async run({ input, signal }) {
                    return toJson(
                      await state.app.executeCodeFromWorkflow(fn, {
                        code: input.code,
                        bindings: env,
                        runId: id,
                        signal,
                      }),
                    );
                  },
                })]
              : []),
            ...(userInputTool ? [userInputTool] : []),
          ],
        }
      : {}),
    ...(subagents.length > 0 ? { subagents } : {}),
    ...(approvalContinuation ? { approvalContinuation } : {}),
  };
  });

  return defineWorkflow({
    agent,
    input: WorkflowEnvelopeSchema,
    async run({ harness, input }) {
      const runtimeHarness = harness as typeof harness & {
        readonly env?: unknown;
      };
      return toJson(
        await state.app.invokeFromWorkflow(fn, {
          input: input.input,
          bindings:
            runtimeHarness.env ?? state.app.options.defaultBindings,
          runId: input.__flary.runId,
        }),
      );
    },
  });
}

/** Compile one prompt-backed function into a persistent Flue agent. */
export function defineFlaryFunctionAgent(
  fn: FlaryFunction<any, any, any>,
): AgentDefinition {
  const state = getFunctionState(fn);
  if (!state) throw new Error("The value is not a Flary function");
  if (state.mode !== "prompt") {
    throw new Error("Only prompt-backed Flary functions compile to Flue agents");
  }
  const definition = state.definition;
  const model = definition.model ?? state.app.options.model ?? "openai/gpt-5";
  return defineAgent(async ({ env, id }): Promise<AgentRuntimeConfig> => {
    const codemodeContinuation = definition.tools
      ? await state.app.approvalContinuationFor(fn, {
          bindings: env,
          runId: id,
        })
      : undefined;
    const userInputTool = createFlaryUserInputTool(env, id);
    const approvalContinuation = combineContinuations(
      codemodeContinuation,
      createFlaryUserInputContinuation(env, id),
    );
    const subagents = await functionSubagents(fn, env, id);
    return {
    model,
    instructions: functionInstructions(fn),
    ...(definition.thinking
      ? { thinkingLevel: toFlueThinkingLevel(definition.thinking as never) }
      : {}),
    durability: {
      maxAttempts: definition.durable?.maxAttempts ?? 10,
      timeoutMs: functionTimeoutMs(
        definition.durable?.timeout,
        definition.limits?.timeoutMs,
      ),
    },
    ...(definition.tools || userInputTool
      ? {
          tools: [
            ...(definition.tools
              ? [defineTool({
                  name: "execute",
                  description:
                    "Run bounded TypeScript in Flary's isolated tool runtime. Search and describe tools before calling them.",
                  input: v.object({ code: v.string() }),
                  async run({ input, signal }) {
                    return toJson(
                      await state.app.executeCodeFromWorkflow(fn, {
                        code: input.code,
                        bindings: env,
                        runId: id,
                        signal,
                      }),
                    );
                  },
                })]
              : []),
            ...(userInputTool ? [userInputTool] : []),
          ],
        }
      : {}),
    ...(subagents.length > 0 ? { subagents } : {}),
    ...(approvalContinuation ? { approvalContinuation } : {}),
  };
  });
}

/**
 * Protect generated Flue agent and workflow routes with a host-only token.
 *
 * The public function API performs tenant checks before it uses these routes.
 */
export function flaryInternalRoute(
  valueOrBinding: FlaryFunction<any, any, any> | string = "FLARY_INTERNAL_TOKEN",
): (
  context: {
    readonly env: Record<string, unknown>;
    readonly req: {
      header(name: string): string | undefined;
      readonly raw?: Request;
    };
    notFound(): Response;
    json?: (value: unknown, status?: number) => Response;
  },
  next: () => Promise<void>,
) => Promise<Response | void> {
  const functionValue = typeof valueOrBinding === "function" ? valueOrBinding : undefined;
  const binding = typeof valueOrBinding === "string"
    ? valueOrBinding
    : "FLARY_INTERNAL_TOKEN";
  return async (context, next) => {
    const expected = context.env[binding];
    const supplied = context.req.header("authorization");
    if (
      typeof expected !== "string" ||
      expected.length < 32 ||
      supplied !== `Bearer ${expected}`
    ) {
      return context.notFound();
    }
    const request = context.req.raw;
    const rpc = request ? new URL(request.url).searchParams.get("flary") : null;
    if (!rpc || !functionValue) {
      await next();
      return;
    }
    if (rpc === "wake" && request?.method === "GET") {
      // The generated Flue agent route handles this private wake request.
      // It must not inspect or consume a model message body.
      await next();
      return;
    }
    const state = getFunctionState(functionValue);
    if (!state) return context.notFound();
    const pathParts = request
      ? new URL(request.url).pathname.split("/").filter(Boolean)
      : [];
    const runId = pathParts.at(-1) ?? "flary";
    const bridge = await state.app.approvalBridgeFor(functionValue, {
      bindings: context.env,
      runId,
      signal: request?.signal,
    });
    if (!bridge) return context.notFound();
    if (rpc === "approvals" && request?.method === "GET") {
      return jsonResponse(context, { approvals: await bridge.list() });
    }
    if (rpc === "approval" && request?.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const decision = ApprovalDecisionSchema.parse(body) as ApprovalDecision;
      await bridge.decide(decision);
      return jsonResponse(context, { ok: true });
    }
    return context.notFound();
  };
}

/**
 * Handle approval RPCs when the Runtime Durable Object calls an agent DO
 * directly. The normal Flue Worker route uses `flaryInternalRoute`; the
 * direct path cannot run Worker middleware, so the generated class calls this
 * small equivalent before Flue receives the request.
 */
export async function flaryInternalRequest(
  functionValue: FlaryFunction<any, any, any>,
  request: Request,
  env: Record<string, unknown>,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const rpc = url.searchParams.get("flary");
  if (!rpc || rpc === "wake") return undefined;
  const expected = env.FLARY_INTERNAL_TOKEN;
  if (
    typeof expected !== "string" ||
    expected.length < 32 ||
    request.headers.get("authorization") !== `Bearer ${expected}`
  ) {
    return new Response(null, { status: 404 });
  }
  const state = getFunctionState(functionValue);
  if (!state) return new Response(null, { status: 404 });
  const runId = url.pathname.split("/").filter(Boolean).at(-1) ?? "flary";
  const bridge = await state.app.approvalBridgeFor(functionValue, {
    bindings: env,
    runId,
    signal: request.signal,
  });
  if (!bridge) return new Response(null, { status: 404 });
  if (rpc === "approvals" && request.method === "GET") {
    return new Response(JSON.stringify({ approvals: await bridge.list() }), {
      headers: { "content-type": "application/json" },
    });
  }
  if (rpc === "approval" && request.method === "POST") {
    const decision = ApprovalDecisionSchema.parse(await request.json());
    await bridge.decide(decision);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(null, { status: 404 });
}

function jsonResponse(
  context: {
    json?: (value: unknown, status?: number) => Response;
  },
  value: unknown,
): Response {
  return context.json?.(value) ?? new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function functionInstructions(
  fn: FlaryFunction<any, any, any>,
): string {
  const state = getFunctionState(fn)!;
  const definition = state.definition;
  const outputSchema = z.toJSONSchema(definition.output);
  return [
    definition.description ?? "Complete the Flary function.",
    definition.mode ? `Operating mode: ${definition.mode}.` : "",
    definition.tools
      ? "You have one execute tool. Its code can search, describe, and call the private tool catalog."
      : "",
    definition.delegation?.mode === "disabled"
      ? "Do not delegate work to subagents."
      : definition.delegation?.mode === "explicit"
        ? "Delegate only when the task clearly requires it."
        : definition.delegation?.mode === "auto"
          ? "Delegate independent work when it improves speed or correctness."
          : "",
    definition.limits?.steps
      ? `Stay within ${definition.limits.steps} model steps.`
      : "",
    definition.limits?.toolCalls
      ? `Stay within ${definition.limits.toolCalls} tool calls.`
      : "",
    "Return only a value that matches this JSON Schema:",
    JSON.stringify(outputSchema),
  ].filter(Boolean).join("\n\n");
}

/** Convert authored prompt functions into Flue's durable delegation profiles. */
async function functionSubagents(
  fn: FlaryFunction<any, any, any>,
  env: unknown,
  id: string,
): Promise<AgentProfile[]> {
  const state = getFunctionState(fn);
  if (!state || state.definition.delegation?.mode === "disabled") return [];
  const profiles: AgentProfile[] = [];
  for (const [name, candidate] of Object.entries(state.definition.subagents ?? {})) {
    const child = getFunctionState(candidate);
    if (!child) throw new Error(`Subagent '${name}' must be a Flary function`);
    if (child.mode !== "prompt") {
      throw new Error(`Subagent '${name}' must use a prompt implementation`);
    }
    const definition = child.definition;
    const tools = definition.tools
      ? [defineTool({
          name: "execute",
          description: "Run bounded TypeScript in Flary's isolated tool runtime.",
          input: v.object({ code: v.string() }),
          async run({ input, signal }) {
            return toJson(await child.app.executeCodeFromWorkflow(candidate, {
              code: input.code,
              bindings: env,
              runId: `${id}:task:${name}`,
              signal,
            }));
          },
        })]
      : undefined;
    profiles.push(defineAgentProfile({
      name,
      ...(definition.description ? { description: definition.description } : {}),
      ...(definition.model ?? child.app.options.model
        ? { model: definition.model ?? child.app.options.model }
        : {}),
      instructions: functionInstructions(candidate as FlaryFunction<any, any, any>),
      ...(definition.thinking
        ? { thinkingLevel: toFlueThinkingLevel(definition.thinking as never) }
        : {}),
      ...(tools ? { tools } : {}),
    }));
  }
  return profiles;
}

function functionTimeoutMs(
  durable: number | string | undefined,
  limit: number | undefined,
): number {
  const parsed = typeof durable === "number"
    ? durable
    : typeof durable === "string"
      ? parseDuration(durable)
      : 3_600_000;
  return limit === undefined ? parsed : Math.min(parsed, limit);
}

function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid Flary duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "ms" ? 1 :
    unit === "s" ? 1_000 :
    unit === "m" ? 60_000 :
    unit === "h" ? 3_600_000 :
    86_400_000;
  return amount * multiplier;
}

function toJson(value: unknown): any {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

interface FlaryRuntimeStub {
  fetch(request: Request): Promise<Response>;
}

interface FlaryRuntimeNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): FlaryRuntimeStub;
}

/**
 * Add the built-in user-input tool only when the generated Cloudflare host
 * has a protected Runtime Durable Object. Local function calls keep the
 * existing explicit host behaviour and do not create an in-memory wait.
 */
function createFlaryUserInputTool(
  env: unknown,
  runId: string,
): ReturnType<typeof createFlueRequestUserInputTool> | undefined {
  const runtime = flaryRuntime(env);
  const token = flaryInternalToken(env);
  if (!runtime || !token) return undefined;

  return createFlueRequestUserInputTool({
    threadKey: runId,
    async createRequest({ questions }) {
      const normalized = UserInputQuestionSchema.array().parse(questions);
      const inputHash = shortHash(stableJson(normalized));
      const request = UserInputRequestSchema.parse({
        id: `input_${shortHash(`${runId}:${inputHash}`)}`,
        threadId: runId,
        questions: normalized,
        requestedBy: { id: "flary", kind: "agent", version: "1" },
        requestedAt: new Date().toISOString(),
        metadata: { flaryInputHash: inputHash },
      });
      const stored = await flaryRuntimeRpc(
        runtime,
        token,
        "createUserInput",
        { runId, request },
      );
      return UserInputRequestSchema.parse(stored);
    },
    async waitForResponse(request, signal) {
      while (true) {
        if (signal?.aborted) throw signal.reason ?? new Error("User-input wait was cancelled");
        const value = await flaryRuntimeRpc(
          runtime,
          token,
          "getUserInput",
          { runId, requestId: request.id },
        );
        if (value !== undefined && value !== null) {
          const record = UserInputRecordSchema.parse(value);
          if (record.response) return UserInputResponseSchema.parse(record.response);
        }
        await delayWithSignal(250, signal);
      }
    },
  });
}

/** Restore a request_user_input tool call after a Worker or DO restart. */
function createFlaryUserInputContinuation(
  env: unknown,
  runId: string,
): ApprovalContinuation | undefined {
  const runtime = flaryRuntime(env);
  const token = flaryInternalToken(env);
  if (!runtime || !token) return undefined;

  const find = async (
    input: ApprovalRecoveryCall,
  ): Promise<UserInputRecord | undefined> => {
    if (input.toolName !== "request_user_input") return undefined;
    const questions = normalizeUserInputQuestions(input.arguments.questions);
    if (!questions) return undefined;
    const inputHash = shortHash(stableJson(questions));
    const value = await flaryRuntimeRpc(
      runtime,
      token,
      "listUserInput",
      { runId },
    );
    if (!Array.isArray(value)) return undefined;
    const records = value
      .map((item) => {
        try {
          return UserInputRecordSchema.parse(item);
        } catch {
          return undefined;
        }
      })
      .filter((item): item is UserInputRecord => Boolean(item));
    return records.find((record) => record.request.metadata?.flaryInputHash === inputHash);
  };

  return {
    async inspect(input): Promise<ApprovalRecoveryState> {
      const record = await find(input);
      if (!record) return "none";
      return record.response ? "ready" : "waiting";
    },
    async resume(input): Promise<ApprovalRecoveryResult> {
      const record = await find(input);
      if (!record?.response) {
        return {
          content: "The user-input request is not available.",
          isError: true,
        };
      }
      const response = UserInputResponseSchema.parse(record.response);
      return {
        content: JSON.stringify(response),
        output: response,
      };
    },
  };
}

function combineContinuations(
  codemode: ApprovalContinuation | undefined,
  userInput: ApprovalContinuation | undefined,
): ApprovalContinuation | undefined {
  if (!codemode) return userInput;
  if (!userInput) return codemode;
  return {
    inspect(input) {
      if (input.toolName === "execute") return codemode.inspect(input);
      if (input.toolName === "request_user_input") return userInput.inspect(input);
      return "none";
    },
    resume(input) {
      if (input.toolName === "execute") return codemode.resume(input);
      if (input.toolName === "request_user_input") return userInput.resume(input);
      return Promise.resolve({
        content: `No recovery handler is registered for '${input.toolName}'.`,
        isError: true,
      });
    },
  };
}

function normalizeUserInputQuestions(value: unknown): UserInputQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    return UserInputQuestionSchema.array().parse(value.map((question) => {
      if (!isRecord(question)) return question;
      return { ...question, multiSelect: question.multiSelect ?? false };
    }));
  } catch {
    return undefined;
  }
}

async function flaryRuntimeRpc(
  runtime: FlaryRuntimeNamespace,
  token: string,
  method: "createUserInput" | "getUserInput" | "listUserInput",
  body: Record<string, unknown>,
): Promise<unknown> {
  const stub = runtime.get(runtime.idFromName("default"));
  const response = await stub.fetch(new Request(`https://flary.internal/rpc/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }));
  const value = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = isRecord(value) && isRecord(value.error) &&
        typeof value.error.message === "string"
      ? value.error.message
      : `Flary Runtime Durable Object request failed (${response.status})`;
    throw new Error(message);
  }
  return value;
}

function flaryRuntime(env: unknown): FlaryRuntimeNamespace | undefined {
  if (!isRecord(env)) return undefined;
  const value = env.FLARY_RUN_SERVICE;
  if (!isRecord(value) ||
      typeof value.idFromName !== "function" ||
      typeof value.get !== "function") return undefined;
  return value as unknown as FlaryRuntimeNamespace;
}

function flaryInternalToken(env: unknown): string | undefined {
  if (!isRecord(env) || typeof env.FLARY_INTERNAL_TOKEN !== "string") return undefined;
  return env.FLARY_INTERNAL_TOKEN.length >= 32 ? env.FLARY_INTERNAL_TOKEN : undefined;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function shortHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
