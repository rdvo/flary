import { z } from "zod";
import {
  RecallKindSchema,
  RecallOpenRequestSchema,
  RecallSearchModeSchema,
  RecallSearchResponseSchema,
  type RecallDocument,
  type RecallReference,
  type RecallScope,
} from "flary/contracts";
import { R2ArtifactHistoryStore, type ArtifactR2Bucket } from "flary/storage";
import { TurbopufferRecallIndex } from "flary/recall";
import type { ThreadBinding } from "flary/contracts";
import type { Env } from "./env";
import { CloudflareArtifactHistoryStore } from "./artifacts-history";

export const ThreadRecallSearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(20_000),
    mode: RecallSearchModeSchema.default("hybrid"),
    kinds: z.array(RecallKindSchema).min(1).max(8).optional(),
    limit: z.number().int().positive().max(100).default(10),
  })
  .strict();
export type ThreadRecallSearchInput = z.input<typeof ThreadRecallSearchInputSchema>;

export const ThreadRecallOpenInputSchema = z
  .object({
    id: z.string().trim().min(1).max(500).optional(),
    reference: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.id && !value.reference) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["id"],
        message: "id or reference is required",
      });
    }
    if (value.id && value.reference) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reference"],
        message: "Use id or reference, not both",
      });
    }
  });
export type ThreadRecallOpenInput = z.input<typeof ThreadRecallOpenInputSchema>;

function recallScope(binding: ThreadBinding): RecallScope {
  return {
    kind: "project",
    organizationId: binding.workspace.organizationId,
    appId: binding.workspace.appId,
    projectId: binding.workspace.projectId,
  };
}

function storageScope(binding: ThreadBinding) {
  return {
    organizationId: binding.workspace.organizationId,
    appId: binding.workspace.appId,
    projectId: binding.workspace.projectId,
    workspaceId: binding.workspace.workspaceId,
    branch: binding.workspace.branch,
  };
}

export function repository(binding: ThreadBinding): string {
  return `project-${binding.workspace.projectId}`;
}

function scopeContains(parent: RecallScope, child: RecallScope): boolean {
  if (parent.organizationId !== child.organizationId) return false;
  if (parent.kind === "organization") return true;
  if (parent.appId !== child.appId) return false;
  if (parent.kind === "app") return true;
  if (parent.projectId !== child.projectId) return false;
  if (parent.kind === "project") return true;
  return parent.sessionId === child.sessionId;
}

export function artifactStore(env: Env, binding: ThreadBinding) {
  const repositoryName = repository(binding);
  if (env.ARTIFACTS) {
    return new CloudflareArtifactHistoryStore({
      artifacts: env.ARTIFACTS,
      scope: storageScope(binding),
      repository: repositoryName,
    });
  }
  const bucket = env.WORKSPACE_BLOBS as unknown as ArtifactR2Bucket | undefined;
  if (!bucket) return undefined;
  return new R2ArtifactHistoryStore({
    bucket,
    scope: storageScope(binding),
    repository: repositoryName,
  });
}

function turbopufferIndex(env: Env) {
  if (!env.TURBOPUFFER_API_KEY || !env.TURBOPUFFER_BASE_URL || !env.TURBOPUFFER_NAMESPACE) {
    return undefined;
  }
  return new TurbopufferRecallIndex({
    apiKey: env.TURBOPUFFER_API_KEY,
    baseUrl: env.TURBOPUFFER_BASE_URL,
    namespace: env.TURBOPUFFER_NAMESPACE,
  });
}

/** Search only the immutable project bound to the thread. */
export async function searchThreadRecall(
  env: Env,
  binding: ThreadBinding,
  input: ThreadRecallSearchInput,
) {
  const request = ThreadRecallSearchInputSchema.parse(input);
  const scope = recallScope(binding);
  const index = turbopufferIndex(env);
  if (index) {
    return index.search({
      ...request,
      scope,
      includeContent: true,
    });
  }

  const store = artifactStore(env, binding);
  if (!store) throw new Error("recall_unavailable");
  const hits = await store.searchExact(repository(binding), scope, request.query, request.limit);
  return RecallSearchResponseSchema.parse({
    results: hits
      .filter((hit) => !request.kinds || request.kinds.includes(kindForPath(hit.path)))
      .map((hit) => {
        const kind = kindForPath(hit.path);
        const id = `artifact:${hit.repository}:${hit.commitId}:${hit.path}:${hit.lineStart}`;
        const reference: RecallReference = {
          id,
          kind,
          organizationId: hit.scope.organizationId,
          appId: hit.scope.appId,
          projectId: hit.scope.projectId,
          sessionId: hit.scope.sessionId,
          repository: hit.repository,
          commit: hit.commitId,
          path: hit.path,
          lineStart: hit.lineStart,
          lineEnd: hit.lineEnd,
          createdAt: hit.createdAt,
        };
        return {
          id,
          snippet: hit.snippet,
          reference,
          score: 1,
          matchType: "exact" as const,
        };
      })
      .slice(0, request.limit),
  });
}

/** Open one result after validating its reference against the thread scope. */
export async function openThreadRecall(
  env: Env,
  binding: ThreadBinding,
  input: ThreadRecallOpenInput,
): Promise<RecallDocument | undefined> {
  const request = ThreadRecallOpenInputSchema.parse(input);
  const scope = recallScope(binding);
  const reference = request.reference
    ? RecallOpenRequestSchema.shape.reference.parse(request.reference)
    : undefined;
  const index = turbopufferIndex(env);
  if (index && (request.id || reference)) {
    return index.open({
      scope,
      ...(request.id ? { id: request.id } : { reference }),
    });
  }

  if (!reference) return undefined;
  const repo = reference.repository;
  const commitId = reference.commit;
  const path = reference.path;
  if (!repo || !commitId || !path) return undefined;
  if (repo !== repository(binding)) return undefined;
  const store = artifactStore(env, binding);
  if (!store) throw new Error("recall_unavailable");
  const commit = await store.read(repo, commitId);
  if (!commit || !scopeContains(scope, commit.scope)) return undefined;
  if (commit.branch !== binding.workspace.branch) return undefined;
  const file = commit.files.find((item) => item.path === path);
  if (!file) return undefined;
  const lines = file.content.split(/\r?\n/);
  const start = Math.max(1, reference.lineStart ?? 1);
  const end = Math.min(lines.length, reference.lineEnd ?? lines.length);
  const content = lines
    .slice(start - 1, end)
    .join("\n")
    .trim();
  if (!content) return undefined;
  return {
    id: reference.id,
    content,
    kind: reference.kind,
    scope: commit.scope,
    reference,
    ...(file.metadata ? { metadata: file.metadata } : {}),
    ...(file.sha256 ? { sourceHash: file.sha256 } : {}),
    createdAt: commit.createdAt,
    deleted: false,
  };
}

function kindForPath(path: string) {
  if (path.startsWith("plans/")) return "plan" as const;
  if (path.startsWith("decisions/")) return "decision" as const;
  if (path.endsWith(".md")) return "plan" as const;
  return "file" as const;
}
