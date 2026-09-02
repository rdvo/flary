import { and, eq, inArray } from "drizzle-orm";
import { observe, type FlueObservation, type FlueEventContext } from "@flue/runtime";
import { ArtifactRecallIndexer, FlaryHistoryProjector, TurbopufferRecallIndex } from "flary";
import { R2ArtifactHistoryStore } from "flary/storage";
import { ThreadBindingSchema, type ThreadBinding } from "flary/contracts";
import { parseThreadName, threadName } from "flary/storage";
import { createDb } from "./db";
import { flaryThread, flaryThreadSubmission } from "./db/schema";
import type { Env } from "./env";
import { internalRequestToken } from "./security/tokens";
import { CloudflareArtifactHistoryStore } from "./artifacts-history";

type ProjectionObservation = Extract<FlueObservation, { type: "agent_end" | "submission_settled" }>;

/**
 * Project completed Flue submissions into immutable history. This is an
 * audit/index projection only: Flue remains the canonical transcript and
 * execution source.
 */
export function registerHistoryProjection(flueFetch: {
  fetch(request: Request, env: Env): Response | Promise<Response>;
}): void {
  observe((observation, context) => {
    if (observation.type !== "agent_end" && observation.type !== "submission_settled") return;
    void checkpointSubmission(flueFetch, observation, context as FlueEventContext<Env>).catch(
      (error) => {
        context.log.error("Flary history projection failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  });
}

async function checkpointSubmission(
  flueFetch: { fetch(request: Request, env: Env): Response | Promise<Response> },
  observation: ProjectionObservation,
  context: FlueEventContext<Env>,
): Promise<void> {
  let ref;
  try {
    ref = parseThreadName(context.id);
  } catch {
    return;
  }
  const env = context.env;
  if (observation.type === "submission_settled") {
    const status =
      observation.outcome === "completed"
        ? "completed"
        : observation.outcome === "aborted"
          ? "cancelled"
          : "failed";
    await createDb(env.DB)
      .update(flaryThreadSubmission)
      .set({
        status,
        errorCode: status === "failed" ? "flue_submission_failed" : null,
        settledAt: new Date(),
      })
      .where(
        and(
          eq(flaryThreadSubmission.organizationId, ref.organizationId),
          eq(flaryThreadSubmission.appId, ref.appId),
          eq(flaryThreadSubmission.agentId, ref.agentId),
          eq(flaryThreadSubmission.threadId, ref.threadId),
          eq(flaryThreadSubmission.submissionId, observation.submissionId),
          inArray(flaryThreadSubmission.status, ["processing", "admitted"]),
        ),
      );
  }
  const rows = await createDb(env.DB)
    .select()
    .from(flaryThread)
    .where(
      and(
        eq(flaryThread.organizationId, ref.organizationId),
        eq(flaryThread.appId, ref.appId),
        eq(flaryThread.agentId, ref.agentId),
        eq(flaryThread.threadId, ref.threadId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || (!env.ARTIFACTS && !env.WORKSPACE_BLOBS)) return;
  const binding = bindingFromRow(row, ref);
  const historyScope = {
    kind: "session" as const,
    organizationId: binding.workspace.organizationId,
    appId: binding.workspace.appId,
    projectId: binding.workspace.projectId,
    sessionId: binding.thread.threadId,
  };
  const repository = `project-${binding.workspace.projectId}`;
  const store = env.ARTIFACTS
    ? new CloudflareArtifactHistoryStore({
        artifacts: env.ARTIFACTS,
        scope: { ...binding.workspace },
        repository,
      })
    : new R2ArtifactHistoryStore({
        bucket: env.WORKSPACE_BLOBS!,
        scope: { ...binding.workspace },
        repository,
      });
  const indexer =
    env.TURBOPUFFER_API_KEY && env.TURBOPUFFER_BASE_URL && env.TURBOPUFFER_NAMESPACE
      ? new ArtifactRecallIndexer(
          new TurbopufferRecallIndex({
            apiKey: env.TURBOPUFFER_API_KEY,
            baseUrl: env.TURBOPUFFER_BASE_URL,
            namespace: env.TURBOPUFFER_NAMESPACE,
          }),
        )
      : undefined;
  const projector = new FlaryHistoryProjector(store, indexer);
  const historyResponse = await flueFetch.fetch(
    new Request(
      `https://flue.internal/agents/flary-thread/${encodeURIComponent(context.id)}/history`,
      {
        headers: {
          "x-flary-internal-token": await internalRequestToken(env.BETTER_AUTH_SECRET, context.id),
        },
      },
    ),
    env,
  );
  if (!historyResponse.ok) {
    throw new Error(`Flue history read failed (${historyResponse.status})`);
  }
  const snapshot = await historyResponse.json();
  const snapshotOffset =
    typeof snapshot === "object" &&
    snapshot !== null &&
    "offset" in snapshot &&
    typeof (snapshot as { offset?: unknown }).offset === "string"
      ? (snapshot as { offset: string }).offset
      : undefined;
  const submissionId =
    "submissionId" in observation && typeof observation.submissionId === "string"
      ? observation.submissionId
      : `event-${observation.eventIndex}`;
  await projector.checkpoint({
    id: `checkpoint-${binding.thread.threadId}-${submissionId}`,
    repository,
    scope: historyScope,
    branch: binding.workspace.branch,
    reason: observation.type === "submission_settled" ? "restore" : "dirty_turn",
    events: [JSON.parse(JSON.stringify(observation))],
    files: [
      {
        path: `sessions/${binding.thread.threadId}/conversation.json`,
        content: JSON.stringify(snapshot),
        mediaType: "application/json",
      },
    ],
    metadata: {
      submissionId,
      outcome: observation.type === "submission_settled" ? observation.outcome : "completed",
      flueOffset: String(observation.eventIndex),
    },
  });
  if (env.FLUE_FLARY_THREAD_AGENT && snapshotOffset) {
    const id = env.FLUE_FLARY_THREAD_AGENT.idFromName(threadName(binding.thread));
    const stub = env.FLUE_FLARY_THREAD_AGENT.get(id) as DurableObjectStub & {
      patchOperational(patch: unknown): Promise<unknown>;
    };
    await stub.patchOperational({
      flueOffset: snapshotOffset,
      flarySequence: observation.eventIndex,
    });
  }
}

function bindingFromRow(
  row: typeof flaryThread.$inferSelect,
  ref: ReturnType<typeof parseThreadName>,
): ThreadBinding {
  const parseJson = (value: string | null | undefined): unknown => {
    if (!value) return undefined;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  };
  return ThreadBindingSchema.parse({
    thread: ref,
    workspace: {
      organizationId: row.organizationId,
      appId: row.appId,
      projectId: row.projectId,
      workspaceId: row.workspaceId,
      branch: row.branch,
    },
    agentId: row.agentId,
    ...(row.persona ? { persona: row.persona } : {}),
    defaultMode: row.defaultMode,
    ...(parseJson(row.defaultModelJson) ? { defaultModel: parseJson(row.defaultModelJson) } : {}),
    defaultThinkingLevel: row.defaultThinkingLevel,
    connectionIds: JSON.parse(row.connectionIdsJson),
    createdBy: { id: row.createdBy, kind: "user", version: "1" },
    status: row.status,
    ...(parseJson(row.parentThreadJson) ? { parentThread: parseJson(row.parentThreadJson) } : {}),
    createdAt: (row.createdAt ?? new Date()).toISOString(),
    updatedAt: (row.updatedAt ?? new Date()).toISOString(),
    ...(parseJson(row.metadataJson) ? { metadata: parseJson(row.metadataJson) } : {}),
  });
}
