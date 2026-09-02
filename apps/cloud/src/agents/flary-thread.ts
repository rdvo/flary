import { and, desc, eq, inArray } from "drizzle-orm";
import { defineAgent, type AgentRouteHandler } from "@flue/runtime";
import { extend } from "@flue/runtime/cloudflare";
import {
  AdmittedProviderCredentialSchema,
  ModelSelectionSchema,
  PromptCacheRetentionSchema,
  ReasoningEffortSchema,
  ThreadBindingSchema,
  ThreadOperationalStateSchema,
  UserInputResponseSchema,
  type ApprovalDecision,
  type ThreadBinding,
  type UserInputResponse,
} from "flary/contracts";
import { parseThreadName } from "flary/storage";
import { createAuth } from "../../worker/auth";
import { createDb } from "../../worker/db";
import { flaryApp, flaryThread, flaryThreadSubmission, member } from "../../worker/db/schema";
import type { Env } from "../../worker/env";
import { FlaryThreadMetadataStore } from "flary/cloudflare";
import { resolveAgentMode, resolveLiveUserInput } from "flary";
import { FLARY_LAZY_TOOL_INSTRUCTIONS } from "flary/flue";
import { createThreadTools } from "../thread-tools";
import { requireRecoveredFlueModel } from "../../worker/provider-credentials";
import { internalRequestToken } from "../../worker/security/tokens";
import { normalizeFlueThinkingLevel } from "../../worker/flue-admission";
import {
  recoverUnsettledSubmissions,
  UNSETTLED_SUBMISSION_STATUSES,
} from "../../worker/submission-recovery";

const DEFAULT_MODEL = "cloudflare/@cf/meta/llama-3.1-8b-instruct";

function jsonObject(value: string | null | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

async function loadThreadBinding(
  env: Env,
  ref: ReturnType<typeof parseThreadName>,
): Promise<ThreadBinding | undefined> {
  const row = await createDb(env.DB)
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
  const value = row[0];
  if (!value) return undefined;
  return ThreadBindingSchema.parse({
    thread: ref,
    workspace: {
      organizationId: value.organizationId,
      appId: value.appId,
      projectId: value.projectId,
      workspaceId: value.workspaceId,
      branch: value.branch,
    },
    agentId: value.agentId,
    ...(value.persona ? { persona: value.persona } : {}),
    defaultMode: value.defaultMode,
    ...(jsonObject(value.defaultModelJson)
      ? { defaultModel: ModelSelectionSchema.parse(jsonObject(value.defaultModelJson)) }
      : {}),
    defaultThinkingLevel: value.defaultThinkingLevel,
    connectionIds: JSON.parse(value.connectionIdsJson),
    createdBy: { id: value.createdBy, kind: "user", version: "1" },
    status: value.status,
    ...(jsonObject(value.parentThreadJson)
      ? { parentThread: jsonObject(value.parentThreadJson) }
      : {}),
    createdAt: (value.createdAt ?? new Date()).toISOString(),
    updatedAt: (value.updatedAt ?? new Date()).toISOString(),
    ...(jsonObject(value.metadataJson) ? { metadata: jsonObject(value.metadataJson) } : {}),
  });
}

async function loadRecentSubmissions(env: Env, ref: ReturnType<typeof parseThreadName>) {
  const rows = await createDb(env.DB)
    .select()
    .from(flaryThreadSubmission)
    .where(
      and(
        eq(flaryThreadSubmission.organizationId, ref.organizationId),
        eq(flaryThreadSubmission.appId, ref.appId),
        eq(flaryThreadSubmission.agentId, ref.agentId),
        eq(flaryThreadSubmission.threadId, ref.threadId),
        inArray(flaryThreadSubmission.status, [...UNSETTLED_SUBMISSION_STATUSES]),
      ),
    )
    .orderBy(desc(flaryThreadSubmission.createdAt))
    // Register a bounded recovery window. A thread may have queued turns
    // with different providers while the Durable Object is being evicted.
    .limit(64);
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    userId: row.userId,
    model: jsonObject(row.modelJson)
      ? ModelSelectionSchema.parse(jsonObject(row.modelJson))
      : undefined,
    thinkingLevel: row.thinkingLevel ? ReasoningEffortSchema.parse(row.thinkingLevel) : undefined,
    cacheRetention: PromptCacheRetentionSchema.parse(row.cacheRetention),
    credential: AdmittedProviderCredentialSchema.parse({
      provider: row.provider,
      source: row.credentialSource,
      billingMode: row.billingMode,
      ...(row.credentialConnectionId ? { connectionId: row.credentialConnectionId } : {}),
      version: row.credentialVersion,
      generation: row.credentialGeneration,
      connectionRef: row.credentialConnectionRef,
    }),
  }));
}

function requestOrigin(request: Request): string {
  return new URL(request.url).origin;
}

/**
 * Authenticate before Flue admits a prompt into the durable thread queue.
 * The later Durable Object request is intentionally not trusted with cookies.
 */
export const route: AgentRouteHandler = async (context, next) => {
  const env = context.env as Env;
  let ref;
  try {
    ref = parseThreadName(context.req.param("id") ?? "");
  } catch {
    return context.json({ error: "Invalid Flary thread id" }, 400);
  }

  const auth = createAuth(env, requestOrigin(context.req.raw));
  const session = await auth.api.getSession({
    headers: context.req.raw.headers,
  });
  const internalToken = context.req.raw.headers.get("x-flary-internal-token");
  const isInternal =
    Boolean(internalToken) &&
    internalToken ===
      (await internalRequestToken(env.BETTER_AUTH_SECRET, context.req.param("id") ?? ""));
  if (!session?.user && !isInternal) {
    return context.json({ error: "Sign in is required" }, 401);
  }

  // Direct Flue POSTs must come through Flary admission. This keeps provider
  // credentials, model snapshots, idempotency, and mode policy on one path.
  if (context.req.raw.method === "POST" && !isInternal) {
    const admissionId = context.req.raw.headers.get("x-flary-admission-id");
    if (!admissionId) {
      return context.json({ error: "Use the authenticated Flary thread message endpoint" }, 409);
    }
    const admission = await createDb(env.DB)
      .select({ id: flaryThreadSubmission.id })
      .from(flaryThreadSubmission)
      .where(
        and(
          eq(flaryThreadSubmission.id, admissionId),
          eq(flaryThreadSubmission.organizationId, ref.organizationId),
          eq(flaryThreadSubmission.appId, ref.appId),
          eq(flaryThreadSubmission.agentId, ref.agentId),
          eq(flaryThreadSubmission.threadId, ref.threadId),
          eq(flaryThreadSubmission.status, "processing"),
        ),
      )
      .limit(1);
    if (!admission[0]) return context.json({ error: "Invalid Flary admission" }, 409);
  }

  if (isInternal && !session?.user) {
    const internalRows = await createDb(env.DB)
      .select({ id: flaryThread.id })
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
    if (!internalRows[0]) return context.json({ error: "Thread not found" }, 404);
    return next();
  }

  const userId = session?.user?.id;
  if (!userId) return context.json({ error: "Sign in is required" }, 401);

  const rows = await createDb(env.DB)
    .select({ organizationId: flaryApp.organizationId })
    .from(flaryApp)
    .innerJoin(member, eq(member.organizationId, flaryApp.organizationId))
    .where(
      and(
        eq(flaryApp.id, ref.appId),
        eq(flaryApp.organizationId, ref.organizationId),
        eq(member.userId, userId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    return context.json({ error: "Thread not found" }, 404);
  }

  return next();
};

export default defineAgent<Env>(async ({ env, id }) => {
  let ref;
  try {
    ref = parseThreadName(id);
  } catch {
    return {
      model: env.FLARY_DEFAULT_MODEL ?? DEFAULT_MODEL,
      instructions:
        "You are a Flary durable thread agent. Work only within the authorized workspace and use approved tools. Keep responses clear and concise.",
      thinkingLevel: "medium",
      durability: { maxAttempts: 10, timeoutMs: 3_600_000 },
    };
  }
  const binding = await loadThreadBinding(env, ref);
  const submissions = binding ? await loadRecentSubmissions(env, ref) : [];
  // Provider registrations are process-scoped in the pinned Flue beta. Load
  // every recent admitted provider before Flue replays a pending turn, not
  // only the newest row.
  if (binding) {
    const activeMode = resolveAgentMode(binding.defaultMode);
    const recovered = await recoverUnsettledSubmissions(
      submissions.filter((submission) => Boolean(submission.model)),
      async (submission) =>
        requireRecoveredFlueModel(
          env,
          binding,
          submission.model!,
          submission.userId ?? binding.createdBy.id,
          submission.credential,
        ),
      async (submission, error) => {
        await createDb(env.DB)
          .update(flaryThreadSubmission)
          .set({
            status: "failed",
            errorCode: error.code,
            settledAt: new Date(),
          })
          .where(
            and(
              eq(flaryThreadSubmission.id, submission.id),
              inArray(flaryThreadSubmission.status, [...UNSETTLED_SUBMISSION_STATUSES]),
            ),
          );
      },
    );
    const submission = submissions.find((candidate) => recovered.has(candidate.id));
    const model = submission
      ? recovered.get(submission.id)!
      : (env.FLARY_DEFAULT_MODEL ?? DEFAULT_MODEL);
    const threadToolset = await createThreadTools(env, binding);
    return {
      model,
      instructions: [
        "You are a Flary durable thread agent.",
        binding.workspace
          ? `Work only within workspace ${binding.workspace.workspaceId} on branch ${binding.workspace.branch}.`
          : "Work only within the authorized workspace.",
        binding.persona ? `Persona: ${binding.persona}.` : "",
        `Active mode: ${activeMode.name ?? activeMode.id}.`,
        activeMode.prompt,
        FLARY_LAZY_TOOL_INSTRUCTIONS,
        "Use approved tools only. Keep responses clear and concise.",
      ]
        .filter(Boolean)
        .join(" "),
      thinkingLevel: normalizeFlueThinkingLevel(
        submission?.thinkingLevel ?? binding.defaultThinkingLevel ?? "medium",
      ),
      tools: threadToolset.tools,
      ...(threadToolset.approvalContinuation
        ? { approvalContinuation: threadToolset.approvalContinuation }
        : {}),
      durability: { maxAttempts: 10, timeoutMs: 3_600_000 },
    };
  }
  return {
    model: env.FLARY_DEFAULT_MODEL ?? DEFAULT_MODEL,
    instructions: [
      "You are a Flary durable thread agent.",
      "Work only within the authorized workspace.",
      "Use approved tools only. Keep responses clear and concise.",
    ]
      .filter(Boolean)
      .join(" "),
    thinkingLevel: normalizeFlueThinkingLevel("medium"),
    tools: [],
    durability: {
      maxAttempts: 10,
      timeoutMs: 3_600_000,
    },
  };
});

/** Keep Flary operational metadata beside Flue without duplicating its stream. */
export const cloudflare = extend({
  base: (Base) =>
    class FlaryThreadAgent extends Base {
      readonly flaryMetadata: FlaryThreadMetadataStore;
      readonly #env: Env;

      constructor(
        ctx: { storage: { sql: ConstructorParameters<typeof FlaryThreadMetadataStore>[0] } },
        env: Env,
      ) {
        super(ctx, env);
        this.#env = env;
        this.flaryMetadata = new FlaryThreadMetadataStore(
          ctx.storage.sql,
          parseThreadName((this as unknown as { name: string }).name),
        );
      }

      async onStart() {
        await super.onStart();
        const ref = parseThreadName((this as unknown as { name: string }).name);
        const binding = await loadThreadBinding(this.#env, ref);
        if (binding) this.flaryMetadata.initializeBinding(binding);
      }

      async initializeBinding(binding: ThreadBinding): Promise<ThreadBinding> {
        return this.flaryMetadata.initializeBinding(binding);
      }

      readBinding(): ThreadBinding | undefined {
        return this.flaryMetadata.readBinding();
      }

      readOperational() {
        return ThreadOperationalStateSchema.parse(this.flaryMetadata.read());
      }

      patchOperational(patch: Parameters<FlaryThreadMetadataStore["patch"]>[0]) {
        return this.flaryMetadata.patch(patch);
      }

      listApprovals() {
        return this.flaryMetadata.listApprovals();
      }

      listEvents(runId?: string) {
        return this.flaryMetadata.listEvents(runId);
      }

      async decideApproval(decision: ApprovalDecision): Promise<{ ok: true }> {
        const hasLiveWaiter = this.flaryMetadata.hasApprovalWaiter(decision.requestId);
        const changed = this.flaryMetadata.decideApproval(decision);
        if (changed && !hasLiveWaiter) {
          await (
            this as unknown as {
              schedule(
                delaySeconds: number,
                callback: "__flueWakeAgentSubmissions",
                payload: undefined,
                options?: { idempotent?: boolean },
              ): Promise<unknown>;
            }
          ).schedule(0, "__flueWakeAgentSubmissions", undefined, {
            idempotent: false,
          });
        }
        return { ok: true };
      }

      listUserInput() {
        return this.flaryMetadata.listUserInputRequests();
      }

      respondToUserInput(responseInput: UserInputResponse) {
        const response = UserInputResponseSchema.parse(responseInput);
        const record = this.flaryMetadata.respondToUserInput(response);
        const live = resolveLiveUserInput((this as unknown as { name: string }).name, response);
        return { live, record };
      }
    },
});
