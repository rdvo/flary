import { z } from "zod";
import {
  ThreadHistoryDiffResponseSchema,
  ThreadHistoryDiffRequestSchema,
  ThreadHistoryListResponseSchema,
  ThreadHistoryListRequestSchema,
  type ThreadBinding,
} from "flary/contracts";
import {
  ArtifactCommitSummarySchema,
  summarizeArtifactCommit,
  type ArtifactDiff,
  type ArtifactHistoryStore,
} from "flary/storage";
import type { Env } from "./env";
import { artifactStore, repository } from "./recall";

export const ThreadHistoryListInputSchema = ThreadHistoryListRequestSchema;
export type ThreadHistoryListInput = z.input<
  typeof ThreadHistoryListInputSchema
>;

export const ThreadHistoryDiffInputSchema = ThreadHistoryDiffRequestSchema;
export type ThreadHistoryDiffInput = z.infer<
  typeof ThreadHistoryDiffInputSchema
>;

function historyScope(binding: ThreadBinding) {
  return {
    kind: "session" as const,
    organizationId: binding.workspace.organizationId,
    appId: binding.workspace.appId,
    projectId: binding.workspace.projectId,
    sessionId: binding.thread.threadId,
  };
}

function historyBranch(binding: ThreadBinding): string {
  return binding.workspace.branch;
}

export async function listThreadHistory(
  env: Env,
  binding: ThreadBinding,
  input: ThreadHistoryListInput,
) {
  const request = ThreadHistoryListInputSchema.parse(input);
  const store = requireHistoryStore(env, binding);
  const commits = await store.list(
    repository(binding),
    historyScope(binding),
    historyBranch(binding),
    request.limit,
  );
  return ThreadHistoryListResponseSchema.parse({
    repository: repository(binding),
    branch: historyBranch(binding),
    checkpoints: commits.map((commit) =>
      ArtifactCommitSummarySchema.parse(summarizeArtifactCommit(commit)),
    ),
  });
}

export async function diffThreadHistory(
  env: Env,
  binding: ThreadBinding,
  input: ThreadHistoryDiffInput,
) {
  const request = ThreadHistoryDiffInputSchema.parse(input);
  const store = requireHistoryStore(env, binding);
  const diff = await store.diff(
    repository(binding),
    historyScope(binding),
    request.baseCommitId,
    request.headCommitId,
    historyBranch(binding),
  );
  return ThreadHistoryDiffResponseSchema.parse({ diff });
}

function requireHistoryStore(
  env: Env,
  binding: ThreadBinding,
): ArtifactHistoryStore {
  const store = artifactStore(env, binding);
  if (!store) throw new Error("history_unavailable");
  return store;
}

export type ThreadHistoryDiff = ArtifactDiff;
