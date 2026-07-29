import { z } from "zod";
import {
  resultBatchOptionsSchema,
  toolExecutionResultSchema,
  type ToolExecutionResult,
} from "./types.js";

export type ResultBatchHandler = (
  batch: readonly ToolExecutionResult[]
) => void | Promise<void>;

function parseBatchSize(value: number): number {
  return resultBatchOptionsSchema.parse({ batchSize: value }).batchSize;
}

function parseResultList(
  results: readonly ToolExecutionResult[]
): ToolExecutionResult[] {
  return z.array(toolExecutionResultSchema).parse([...results]);
}

export function batchResults(
  results: readonly ToolExecutionResult[],
  batchSize: number
): ToolExecutionResult[][] {
  const parsedResults = parseResultList(results);
  const size = parseBatchSize(batchSize);
  const batches: ToolExecutionResult[][] = [];

  for (let index = 0; index < parsedResults.length; index += size) {
    batches.push(parsedResults.slice(index, index + size));
  }

  return batches;
}

export async function deliverBatchedResults(
  results: readonly ToolExecutionResult[],
  batchSizeOrOptions: number | { readonly batchSize: number },
  deliver: ResultBatchHandler
): Promise<readonly (readonly ToolExecutionResult[])[]> {
  const batchSize =
    typeof batchSizeOrOptions === "number"
      ? parseBatchSize(batchSizeOrOptions)
      : resultBatchOptionsSchema.parse(batchSizeOrOptions).batchSize;
  z.custom<ResultBatchHandler>((value) => typeof value === "function").parse(
    deliver
  );

  const batches = batchResults(results, batchSize);
  for (const batch of batches) {
    await deliver(Object.freeze([...batch]));
  }
  return batches;
}

export interface ResultBatcherOptions {
  readonly batchSize: number;
  readonly deliver: ResultBatchHandler;
}

export class ResultBatcher {
  readonly #batchSize: number;
  readonly #deliver: ResultBatchHandler;
  readonly #pending: ToolExecutionResult[] = [];
  #delivery: Promise<void> = Promise.resolve();

  constructor(options: ResultBatcherOptions) {
    const parsed = z
      .object({
        batchSize: z.number().int().positive(),
        deliver: z
          .custom<ResultBatchHandler>((value) => typeof value === "function"),
      })
      .strict()
      .parse(options);
    this.#batchSize = parsed.batchSize;
    this.#deliver = parsed.deliver;
  }

  push(result: ToolExecutionResult): Promise<void> {
    const parsed = toolExecutionResultSchema.parse(result);
    this.#pending.push(parsed);
    if (this.#pending.length >= this.#batchSize) {
      return this.flushFullBatches();
    }
    return this.#delivery;
  }

  flush(): Promise<void> {
    if (this.#pending.length === 0) {
      return this.#delivery;
    }
    const batch = this.#pending.splice(0, this.#pending.length);
    this.#delivery = this.#delivery.then(() =>
      this.#deliver(Object.freeze([...batch]))
    ).then(() => undefined);
    return this.#delivery;
  }

  private flushFullBatches(): Promise<void> {
    while (this.#pending.length >= this.#batchSize) {
      const batch = this.#pending.splice(0, this.#batchSize);
      this.#delivery = this.#delivery.then(() =>
        this.#deliver(Object.freeze([...batch]))
      ).then(() => undefined);
    }
    return this.#delivery;
  }
}

export const createResultBatcher = (
  options: ResultBatcherOptions
): ResultBatcher => new ResultBatcher(options);

