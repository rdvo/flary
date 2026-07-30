import { z } from "zod";

import {
  JsonObjectSchema,
  type ToolCatalogDefinitionInput,
  type ToolOperation,
} from "../contracts/index";
import type {
  ToolCapabilityContext,
  ToolCatalog,
  ToolCatalogRegistration,
} from "./catalog";

export interface DefineFlaryToolOptions<
  TInput extends z.ZodType,
  TOutput extends z.ZodType | undefined = undefined,
> {
  id: string;
  name?: string;
  description?: string;
  input: TInput;
  output?: TOutput;
  kind?: ToolCatalogDefinitionInput["kind"];
  operation?: ToolOperation;
  capabilities?: string[];
  tags?: string[];
  secretRefs?: string[];
  requiresApproval?: boolean;
  concurrencyKey?: string;
  resourceKey?:
    | string
    | ((input: z.output<TInput>) => string | undefined);
  execute(
    input: z.output<TInput>,
    context: ToolCapabilityContext,
  ): unknown | PromiseLike<unknown>;
}

export interface DefinedFlaryTool {
  readonly id: string;
  register(catalog: ToolCatalog): void;
}

export interface FlaryToolset {
  readonly tools: readonly DefinedFlaryTool[];
  register(catalog: ToolCatalog): void;
}

/**
 * Define one host tool with Zod-owned input and output validation.
 *
 * The executable closure and secret provider stay private. Only JSON Schema
 * metadata is returned by Tool Search.
 */
export function defineFlaryTool<
  TInput extends z.ZodType,
  TOutput extends z.ZodType | undefined = undefined,
>(
  options: DefineFlaryToolOptions<TInput, TOutput>,
): DefinedFlaryTool {
  const resourceKey = options.resourceKey;
  const definition: ToolCatalogDefinitionInput = {
    id: options.id,
    name: options.name ?? options.id,
    kind: options.kind ?? "function",
    inputSchema: toJsonSchema(options.input),
    operation: options.operation ?? "read",
    capabilities: options.capabilities ?? [],
    tags: options.tags ?? [],
    ...(options.description ? { description: options.description } : {}),
    ...(options.output
      ? { outputSchema: toJsonSchema(options.output) }
      : {}),
    ...(options.secretRefs ? { secretRefs: options.secretRefs } : {}),
    ...(options.requiresApproval !== undefined
      ? { requiresApproval: options.requiresApproval }
      : {}),
    ...(options.concurrencyKey
      ? { concurrencyKey: options.concurrencyKey }
      : {}),
  };

  return {
    id: options.id,
    register(catalog: ToolCatalog): void {
      const registration: ToolCatalogRegistration = {
        definition,
        async execute(input, context) {
          const parsedInput = options.input.parse(input);
          const value = await options.execute(parsedInput, context);
          return options.output ? options.output.parse(value) : value;
        },
        ...(resourceKey
          ? {
              resourceKey:
                typeof resourceKey === "function"
                  ? (input: unknown) =>
                      resourceKey(
                        options.input.parse(input) as z.output<TInput>,
                      )
                  : resourceKey,
            }
          : {}),
      };
      catalog.register(registration);
    },
  };
}

export function defineFlaryToolset(
  tools: readonly DefinedFlaryTool[],
): FlaryToolset {
  const ids = new Set<string>();
  for (const tool of tools) {
    if (ids.has(tool.id)) throw new Error(`Duplicate Flary tool: ${tool.id}`);
    ids.add(tool.id);
  }
  return Object.freeze({
    tools: Object.freeze([...tools]),
    register(catalog: ToolCatalog): void {
      for (const tool of tools) tool.register(catalog);
    },
  });
}

function toJsonSchema(schema: z.ZodType) {
  return JsonObjectSchema.parse(z.toJSONSchema(schema));
}
