import { z } from "zod";
import {
  nonEmptyStringSchema,
  type ToolTask,
} from "./types.js";

export const idempotencyKeySchema = nonEmptyStringSchema;

function stableValue(value: unknown, seen: Set<object>): string {
  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "undefined";
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (Number.isNaN(value)) return "number:NaN";
      if (value === Infinity) return "number:Infinity";
      if (value === -Infinity) return "number:-Infinity";
      if (Object.is(value, -0)) return "number:-0";
      return `number:${String(value)}`;
    case "bigint":
      return `bigint:${String(value)}`;
    case "symbol":
      return `symbol:${String(value)}`;
    case "function":
      return `function:${value.name || "anonymous"}`;
  }

  if (seen.has(value)) {
    throw new TypeError("Cannot create an idempotency key from a cyclic value");
  }
  seen.add(value);

  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => stableValue(item, seen)).join(",")}]`;
  } else if (value instanceof Date) {
    result = `date:${value.toISOString()}`;
  } else {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    result = `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableValue(object[key], seen)}`)
      .join(",")}}`;
  }

  seen.delete(value);
  return result;
}

export function stableStringify(value: unknown): string {
  z.unknown().parse(value);
  return stableValue(value, new Set<object>());
}

interface IdempotencyKeyInput {
  readonly toolName: string;
  readonly input?: unknown;
  readonly operation?: "read" | "write";
  readonly resourceKey?: string;
}

const idempotencyKeyInputSchema = z
  .object({
    toolName: nonEmptyStringSchema,
    input: z.unknown().optional(),
    operation: z.enum(["read", "write"]).optional(),
    resourceKey: nonEmptyStringSchema.optional(),
  })
  .strict();

export function createIdempotencyKey(
  input: string | IdempotencyKeyInput,
  toolInput?: unknown
): string {
  if (typeof input === "string") {
    const toolName = nonEmptyStringSchema.parse(input);
    return `tool:${toolName}:input:${stableStringify(toolInput)}`;
  }

  const parsed = idempotencyKeyInputSchema.parse(input);
  return `tool:${parsed.toolName}:operation:${
    parsed.operation ?? "read"
  }:resource:${parsed.resourceKey ?? ""}:input:${stableStringify(parsed.input)}`;
}

export function idempotencyKeyForTask(
  task: Pick<ToolTask, "name" | "input" | "operation" | "resourceKey">,
  automatic = true
): string | undefined {
  const explicit = (task as ToolTask).idempotencyKey;
  if (explicit) {
    return idempotencyKeySchema.parse(explicit);
  }
  if (!automatic) {
    return undefined;
  }

  return createIdempotencyKey({
    toolName: task.name,
    input: task.input,
    operation: task.operation,
    resourceKey: task.resourceKey,
  });
}

export interface IdempotencyExecution<T> {
  readonly value: T;
  readonly reused: boolean;
}

export class IdempotencyStore<T> {
  readonly #completed = new Map<string, T>();
  readonly #pending = new Map<string, Promise<T>>();

  has(key: string): boolean {
    idempotencyKeySchema.parse(key);
    return this.#completed.has(key);
  }

  get(key: string): T | undefined {
    idempotencyKeySchema.parse(key);
    return this.#completed.get(key);
  }

  set(key: string, value: T): void {
    idempotencyKeySchema.parse(key);
    this.#completed.set(key, value);
  }

  delete(key: string): boolean {
    idempotencyKeySchema.parse(key);
    return this.#completed.delete(key);
  }

  clear(): void {
    this.#completed.clear();
    this.#pending.clear();
  }

  get size(): number {
    return this.#completed.size;
  }

  async execute(
    key: string,
    operation: () => T | Promise<T>
  ): Promise<IdempotencyExecution<T>> {
    idempotencyKeySchema.parse(key);
    z.custom<() => T | Promise<T>>((value) => typeof value === "function").parse(
      operation
    );

    if (this.#completed.has(key)) {
      return { value: this.#completed.get(key) as T, reused: true };
    }

    const pending = this.#pending.get(key);
    if (pending) {
      return { value: await pending, reused: true };
    }

    const promise = Promise.resolve().then(operation);
    this.#pending.set(key, promise);

    try {
      const value = await promise;
      this.#completed.set(key, value);
      return { value, reused: false };
    } finally {
      this.#pending.delete(key);
    }
  }
}

export const IdempotencyRegistry = IdempotencyStore;

export function createIdempotencyStore<T>(): IdempotencyStore<T> {
  return new IdempotencyStore<T>();
}

