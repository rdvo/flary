import { z } from "zod";

import {
  ArtifactCommitSchema,
  type ArtifactCommit,
  type ArtifactCommitInput,
  type ArtifactHistoryStore,
} from "../storage/artifacts.js";
import { RecallScopeSchema } from "../contracts/recall.js";
import { MetadataSchema, NonEmptyStringSchema, TimestampSchema } from "../contracts/common.js";
import type { ArtifactRecallIndexer } from "../recall/artifacts.js";

export const HistoryCheckpointReasonSchema = z.enum([
  "dirty_turn",
  "explicit_commit",
  "mode_change",
  "restore",
  "sandbox_import",
]);
export type HistoryCheckpointReason = z.infer<typeof HistoryCheckpointReasonSchema>;

export const HistoryCheckpointInputSchema = z
  .object({
    id: NonEmptyStringSchema.max(200),
    repository: NonEmptyStringSchema.max(500),
    scope: RecallScopeSchema,
    branch: NonEmptyStringSchema.max(200).default("main"),
    parentId: NonEmptyStringSchema.max(200).optional(),
    reason: HistoryCheckpointReasonSchema,
    createdAt: TimestampSchema.default(() => new Date().toISOString()),
    events: z.array(z.json()).max(50_000).default([]),
    files: z.array(
      z
        .object({
          path: z.string().trim().min(1).max(2_000),
          content: z.string().max(64 * 1024 * 1024),
          mediaType: z.string().trim().min(1).max(255).default("text/plain"),
          sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
          metadata: MetadataSchema.optional(),
        })
        .strict(),
    ).max(10_000).default([]),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type HistoryCheckpointInput = z.input<typeof HistoryCheckpointInputSchema>;

export interface HistoryCheckpointResult {
  readonly commit: ArtifactCommit;
  readonly indexedDocumentIds: readonly string[];
  readonly reused: boolean;
}

/**
 * Projects Flue events into immutable history. It does not execute a run and
 * never becomes a second transcript source.
 */
export class FlaryHistoryProjector {
  constructor(
    private readonly store: ArtifactHistoryStore,
    private readonly indexer?: ArtifactRecallIndexer,
  ) {}

  async checkpoint(inputInput: HistoryCheckpointInput): Promise<HistoryCheckpointResult> {
    const input = HistoryCheckpointInputSchema.parse(inputInput);
    const eventFile = input.events.length
      ? {
          path: `sessions/${input.scope.sessionId ?? "project"}/stream.jsonl`,
          content: input.events.map((event) => JSON.stringify(event)).join("\n") + "\n",
          mediaType: "application/jsonl",
        }
      : undefined;
    const commitInput: ArtifactCommitInput = {
      id: input.id,
      repository: input.repository,
      scope: input.scope,
      branch: input.branch,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      files: [...input.files, ...(eventFile ? [eventFile] : [])],
      createdAt: input.createdAt,
      metadata: {
        ...input.metadata,
        checkpointReason: input.reason,
      },
    };
    const before = await this.store.read(input.repository, input.id);
    const commit = await this.store.checkpoint(commitInput);
    const indexedDocumentIds = this.indexer
      ? await this.indexer.indexCommit(commit)
      : [];
    return {
      commit: ArtifactCommitSchema.parse(commit),
      indexedDocumentIds,
      reused: Boolean(before),
    };
  }
}

export interface HistoryIndexQueueJob {
  readonly id: string;
  readonly commit: ArtifactCommit;
  readonly attempts: number;
}

/**
 * Small idempotent queue used by Workers Queue, a DO alarm, or a test. A
 * production adapter can persist these jobs without changing the contract.
 */
export class InMemoryHistoryIndexQueue {
  readonly #jobs = new Map<string, HistoryIndexQueueJob>();

  enqueue(commitInput: ArtifactCommit): HistoryIndexQueueJob {
    const commit = ArtifactCommitSchema.parse(commitInput);
    const current = this.#jobs.get(commit.id);
    if (current) return current;
    const job = { id: commit.id, commit, attempts: 0 };
    this.#jobs.set(job.id, job);
    return job;
  }

  size(): number {
    return this.#jobs.size;
  }

  async drain(indexer: ArtifactRecallIndexer): Promise<readonly string[]> {
    const ids: string[] = [];
    for (const [id, job] of this.#jobs) {
      const current = { ...job, attempts: job.attempts + 1 };
      this.#jobs.set(id, current);
      await indexer.indexCommit(current.commit);
      this.#jobs.delete(id);
      ids.push(id);
    }
    return ids;
  }
}
