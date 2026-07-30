import { and, asc, desc, eq, inArray, ne, or } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { z } from "zod";
import {
  CodeExecutionRequestSchema,
  ConnectionCreateInputSchema,
  ConnectionSchema,
  ConnectionSecretInputSchema,
  ProviderOAuthCompleteInputSchema,
  ProviderOAuthStartInputSchema,
  SubscriptionProviderSchema,
  PromptAssignmentSchema,
  PromptOverrideSchema,
  ApprovalDecisionSchema,
  ThreadBindingSchema,
  ThreadConnectionsRequestSchema,
  ThreadCreateRequestSchema,
  ThreadForkRequestSchema,
  ThreadMessageRequestSchema,
  ThreadModeRequestSchema,
  ThreadOperationalStateSchema,
  ProviderKindSchema,
  StorageIdentifierSchema,
  TraceContextSchema,
  WorkspaceDownloadTicketRequestSchema,
  WorkspaceUploadTicketRequestSchema,
  UserInputAnswerRequestSchema,
  UserInputRequestSchema,
  UserInputResponseSchema,
} from "flary/contracts";
import { createAuth } from "./auth";
import { createDb } from "./db";
import {
  cloudflareConnection,
  cloudflareOAuthState,
  flaryConnection,
  flaryApp,
  member,
  organization,
  prompt,
  promptRevision,
  promptVariant,
  secretEnvelope,
  flaryThread,
  flaryThreadSubmission,
} from "./db/schema";
import type { Env } from "./env";
import { createCloudExecutionRouter } from "./execution";
import {
  connectionSecretAssociatedData,
  encryptToken,
  hashOAuthState,
} from "./security/tokens";
import {
  buildCloudflareAuthorizationUrl,
  cloudflareOAuthRedirectUri,
  cloudflareOAuthScopes,
  decryptCloudflareToken,
  ensureCloudflareGateway,
  exchangeCloudflareCode,
  encryptCloudflareToken,
  fetchCloudflareAccounts,
  isCloudflareOAuthConfigured,
  revokeCloudflareToken,
} from "./cloudflare-oauth";
import {
  createTraceContext,
  frameRestoredUserInputResponse,
  selectPromptVariantWithTelemetry,
} from "flary";
import { parseFlueModelSpecifier } from "flary/providers";
import {
  prepareAdmittedFlueModel,
} from "./provider-credentials";
import { disconnectSubscriptionCredential } from "./provider-subscriptions";
import {
  cancelCloudProviderOAuth,
  CloudProviderOAuthError,
  completeCloudProviderOAuth,
  getCloudProviderOAuth,
  startCloudProviderOAuth,
} from "./provider-oauth";
import { normalizeFlueThinkingLevel } from "./flue-admission";
import { threadName } from "flary/storage";
import { flueApp } from "../src/flue-app";
import {
  searchThreadRecall,
  openThreadRecall,
  ThreadRecallSearchInputSchema,
  ThreadRecallOpenInputSchema,
} from "./recall";
import {
  diffThreadHistory,
  listThreadHistory,
  ThreadHistoryDiffInputSchema,
  ThreadHistoryListInputSchema,
} from "./thread-history";
import { registerHistoryProjection } from "./history-projector";

registerHistoryProjection(flueApp);

export { OrgCoordinator } from "./durable/org-coordinator";
export { WorkspaceFilesystem } from "./durable/workspace-filesystem";
export { ContainerProxy, FlarySandbox } from "./sandbox-runtime";

type AppContext = {
  Bindings: Env;
};

const app = new Hono<AppContext>();

const organizationInputSchema = z
  .object({ name: z.string().trim().min(2).max(80) })
  .strict();
const appInputSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    organizationId: z.string().min(1),
  })
  .strict();
const promptInputSchema = z
  .object({
    slug: z.string().trim().min(1).max(160),
    source: z.string().min(1).max(1_000_000),
    sourceHash: z.string().min(1).max(128),
    sourceCommit: z.string().max(200).optional(),
    model: z.string().max(200).optional(),
    thinking: z.string().max(64).optional(),
  })
  .strict();
const promptVariantInputSchema = z
  .object({
    rolloutId: z.string().trim().min(1).max(160),
    scope: z
      .enum(["global", "organization", "project", "user", "session", "request"])
      .default("user"),
    variants: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(160),
            revisionId: z.string().trim().min(1).max(200),
            allocationBasisPoints: z.number().int().min(0).max(10_000),
            enabled: z.boolean().default(true),
          })
          .strict()
      )
      .min(1)
      .max(128),
  })
  .strict()
  .superRefine((value, context) => {
    const total = value.variants.reduce(
      (sum, variant) => sum + variant.allocationBasisPoints,
      0
    );
    if (total !== 10_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variants"],
        message: "Variant allocation must total 10000 basis points",
      });
    }
    const ids = new Set(value.variants.map((variant) => variant.id));
    if (ids.size !== value.variants.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variants"],
        message: "Variant IDs must be unique within a rollout",
      });
    }
  });
const promptVariantSelectionInputSchema = z
  .object({
    rolloutId: z.string().trim().min(1).max(160),
    assignment: z.union([
      z.string().trim().min(1).max(512),
      PromptAssignmentSchema,
    ]),
    override: PromptOverrideSchema.optional(),
    traceContext: TraceContextSchema.optional(),
    runId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const cloudflareAccountSchema = z
  .object({
    accountId: z.string().min(1),
    accountName: z.string().min(1).max(200),
  })
  .strict();

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "workspace"
  );
}

function requestOrigin(request: Request): string {
  return new URL(request.url).origin;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function requireUser(context: Context<AppContext>) {
  const auth = createAuth(context.env, requestOrigin(context.req.raw));
  const session = await auth.api.getSession({
    headers: context.req.raw.headers,
  });
  if (!session?.user) {
    throw new HTTPException(401, { message: "Sign in is required" });
  }
  return { auth, session };
}

async function requireOrganizationMember(
  context: Context<AppContext>,
  organizationId: string
) {
  const { session } = await requireUser(context);
  const db = createDb(context.env.DB);
  const rows = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(member.userId, session.user.id)
      )
    )
    .limit(1);
  if (!rows[0]) {
    throw new HTTPException(403, {
      message: "You are not a member of this organization",
    });
  }
  return { session, role: rows[0].role };
}

async function readJson<T>(context: Context<AppContext>): Promise<T> {
  try {
    return (await context.req.json()) as T;
  } catch {
    throw new HTTPException(400, {
      message: "Request body must be valid JSON",
    });
  }
}

function cloudflareRedirect(
  context: Context<AppContext>,
  params: Record<string, string>
) {
  const target = new URL("/", context.env.APP_URL);
  for (const [key, value] of Object.entries(params))
    target.searchParams.set(key, value);
  return context.redirect(target.toString(), 303);
}

function parseCloudflareAccountOptions(value: string): Array<{ id: string; name: string }> {
  try {
    const parsed = z
      .array(z.object({ id: z.string().min(1), name: z.string().min(1) }))
      .safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function cloudflareErrorReason(cause: unknown): string {
  if (cause instanceof Error && cause.name === "CloudflareOAuthError") {
    return cause.message.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 80);
  }
  return "connection_failed";
}

app.use("*", async (context, next) => {
  await next();
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Referrer-Policy", "strict-origin-when-cross-origin");
  context.header("X-Frame-Options", "DENY");
  context.header("Cross-Origin-Resource-Policy", "same-origin");
});

app.get("/health", (context) =>
  context.json({
    ok: true,
    service: "flary-cloud",
    environment: context.env.APP_ENV,
  })
);

app.all("/api/auth/*", (context) =>
  createAuth(context.env, requestOrigin(context.req.raw)).handler(
    context.req.raw
  )
);

app.get("/api/me", async (context) => {
  const { session } = await requireUser(context);
  const db = createDb(context.env.DB);
  const organizations = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, session.user.id))
    .orderBy(asc(organization.createdAt));
  return context.json({ user: session.user, organizations });
});

app.get("/api/organizations", async (context) => {
  const { session } = await requireUser(context);
  const db = createDb(context.env.DB);
  const organizations = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, session.user.id))
    .orderBy(asc(organization.createdAt));
  return context.json({ organizations });
});

app.post("/api/organizations", async (context) => {
  const { session } = await requireUser(context);
  const input = organizationInputSchema.parse(await readJson<unknown>(context));
  const db = createDb(context.env.DB);
  const id = crypto.randomUUID();
  const slug = `${slugify(input.name)}-${id.slice(0, 8)}`;
  await db.insert(organization).values({ id, name: input.name, slug });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: id,
    userId: session.user.id,
    role: "owner",
  });
  return context.json(
    { organization: { id, name: input.name, slug, role: "owner" } },
    201
  );
});

app.get("/api/organizations/:organizationId/apps", async (context) => {
  const organizationId = context.req.param("organizationId");
  await requireOrganizationMember(context, organizationId);
  const db = createDb(context.env.DB);
  const apps = await db
    .select({
      id: flaryApp.id,
      name: flaryApp.name,
      slug: flaryApp.slug,
      createdAt: flaryApp.createdAt,
      updatedAt: flaryApp.updatedAt,
    })
    .from(flaryApp)
    .where(eq(flaryApp.organizationId, organizationId))
    .orderBy(asc(flaryApp.createdAt));
  return context.json({ apps });
});

app.post("/api/organizations/:organizationId/apps", async (context) => {
  const organizationId = context.req.param("organizationId");
  const { session } = await requireOrganizationMember(context, organizationId);
  const input = appInputSchema.parse({
    ...(await readJson<Record<string, unknown>>(context)),
    organizationId,
  });
  const db = createDb(context.env.DB);
  const id = crypto.randomUUID();
  const slug = `${slugify(input.name)}-${id.slice(0, 8)}`;
  await db.insert(flaryApp).values({
    id,
    organizationId,
    name: input.name,
    slug,
    createdBy: session.user.id,
  });
  return context.json(
    { app: { id, organizationId, name: input.name, slug } },
    201
  );
});

async function requireAppMember(context: Context<AppContext>, appId: string) {
  const { session } = await requireUser(context);
  const db = createDb(context.env.DB);
  const rows = await db
    .select({ organizationId: flaryApp.organizationId })
    .from(flaryApp)
    .innerJoin(member, eq(member.organizationId, flaryApp.organizationId))
    .where(and(eq(flaryApp.id, appId), eq(member.userId, session.user.id)))
    .limit(1);
  if (!rows[0]) throw new HTTPException(404, { message: "App not found" });
  return { session, organizationId: rows[0].organizationId };
}

type FlaryThreadRow = typeof flaryThread.$inferSelect;

function parseOptionalJson(value: string | null | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function threadBindingFromRow(row: FlaryThreadRow) {
  return ThreadBindingSchema.parse({
    thread: {
      organizationId: row.organizationId,
      appId: row.appId,
      agentId: row.agentId,
      threadId: row.threadId,
    },
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
    ...(parseOptionalJson(row.defaultModelJson)
      ? { defaultModel: parseOptionalJson(row.defaultModelJson) }
      : {}),
    defaultThinkingLevel: row.defaultThinkingLevel,
    connectionIds: JSON.parse(row.connectionIdsJson),
    createdBy: { id: row.createdBy, kind: "user", version: "1" },
    status: row.status,
    ...(parseOptionalJson(row.parentThreadJson)
      ? { parentThread: parseOptionalJson(row.parentThreadJson) }
      : {}),
    createdAt: (row.createdAt ?? new Date()).toISOString(),
    updatedAt: (row.updatedAt ?? new Date()).toISOString(),
    ...(parseOptionalJson(row.metadataJson)
      ? { metadata: parseOptionalJson(row.metadataJson) }
      : {}),
  });
}

function threadStub(env: Env, binding: ReturnType<typeof threadBindingFromRow>) {
  if (!env.FLUE_FLARY_THREAD_AGENT) {
    throw new HTTPException(503, {
      message: "The Flue thread Durable Object binding is not configured",
    });
  }
  const id = env.FLUE_FLARY_THREAD_AGENT.idFromName(threadName(binding.thread));
  return env.FLUE_FLARY_THREAD_AGENT.get(id) as DurableObjectStub & {
    initializeBinding(binding: unknown): Promise<unknown>;
    readBinding(): Promise<unknown>;
    readOperational(): Promise<unknown>;
    patchOperational(patch: unknown): Promise<unknown>;
    listApprovals(): Promise<unknown[]>;
    decideApproval(decision: unknown): Promise<{ ok: true }>;
    listUserInput(): Promise<unknown[]>;
    respondToUserInput(
      response: unknown,
    ): Promise<{ live: boolean; record: { request: unknown; response: unknown } }>;
  };
}

async function loadThreadRow(
  context: Context<AppContext>,
  appId: string,
  threadId: string,
) {
  const { session, organizationId } = await requireAppMember(context, appId);
  const rows = await createDb(context.env.DB)
    .select()
    .from(flaryThread)
    .where(
      and(
        eq(flaryThread.organizationId, organizationId),
        eq(flaryThread.appId, appId),
        eq(flaryThread.threadId, threadId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new HTTPException(404, { message: "Thread not found" });
  return { session, organizationId, row, binding: threadBindingFromRow(row) };
}

async function insertThread(
  context: Context<AppContext>,
  bindingInput: Parameters<typeof ThreadBindingSchema.parse>[0],
) {
  const binding = ThreadBindingSchema.parse(bindingInput);
  const db = createDb(context.env.DB);
  const row = {
    id: crypto.randomUUID(),
    organizationId: binding.thread.organizationId,
    appId: binding.thread.appId,
    agentId: binding.thread.agentId,
    threadId: binding.thread.threadId,
    projectId: binding.workspace.projectId,
    workspaceId: binding.workspace.workspaceId,
    branch: binding.workspace.branch,
    persona: binding.persona,
    defaultMode: binding.defaultMode,
    defaultModelJson: binding.defaultModel
      ? JSON.stringify(binding.defaultModel)
      : null,
    defaultThinkingLevel: binding.defaultThinkingLevel,
    connectionIdsJson: JSON.stringify(binding.connectionIds),
    status: binding.status,
    createdBy: binding.createdBy.id,
    parentThreadJson: binding.parentThread
      ? JSON.stringify(binding.parentThread)
      : null,
    metadataJson: binding.metadata ? JSON.stringify(binding.metadata) : null,
    createdAt: new Date(binding.createdAt),
    updatedAt: new Date(binding.updatedAt),
  };
  await db.insert(flaryThread).values(row);
  try {
    if (context.env.FLUE_FLARY_THREAD_AGENT) {
      await threadStub(context.env, binding).initializeBinding(binding);
    }
  } catch (error) {
    await db.delete(flaryThread).where(eq(flaryThread.id, row.id));
    throw error;
  }
  return binding;
}

async function assertThreadConnections(
  context: Context<AppContext>,
  organizationId: string,
  appId: string,
  userId: string,
  connectionIds: readonly string[],
): Promise<void> {
  if (connectionIds.length === 0) return;
  const rows = await createDb(context.env.DB)
    .select({ id: flaryConnection.id })
    .from(flaryConnection)
    .where(
      and(
        eq(flaryConnection.organizationId, organizationId),
        eq(flaryConnection.appId, appId),
        inArray(flaryConnection.id, [...connectionIds]),
        or(
          ne(flaryConnection.billingMode, "subscription"),
          eq(flaryConnection.ownerUserId, userId),
        ),
        // A disabled connection cannot be granted to a new or existing
        // thread. The connection can be re-enabled before granting it again.
        inArray(flaryConnection.status, ["configured", "ready", "needs_auth"]),
      ),
    );
  const allowed = new Set(rows.map((row) => row.id));
  if (connectionIds.some((id) => !allowed.has(id))) {
    throw new HTTPException(403, {
      message: "A thread connection is not authorized for this application",
    });
  }
}

app.get("/api/apps/:appId/threads", async (context) => {
  const appId = context.req.param("appId");
  const { organizationId } = await requireAppMember(context, appId);
  const rows = await createDb(context.env.DB)
    .select()
    .from(flaryThread)
    .where(
      and(
        eq(flaryThread.organizationId, organizationId),
        eq(flaryThread.appId, appId),
      ),
    )
    .orderBy(desc(flaryThread.updatedAt));
  return context.json({ threads: rows.map(threadBindingFromRow) });
});

app.post("/api/apps/:appId/threads", async (context) => {
  const appId = context.req.param("appId");
  const { session, organizationId } = await requireAppMember(context, appId);
  const input = ThreadCreateRequestSchema.parse(await readJson<unknown>(context));
  if (
    input.workspace.organizationId !== organizationId ||
    input.workspace.appId !== appId
  ) {
    throw new HTTPException(403, {
      message: "The workspace does not belong to this application",
    });
  }
  await assertThreadConnections(
    context,
    organizationId,
    appId,
    session.user.id,
    input.connectionIds,
  );
  const threadId = input.threadId ?? `thread_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = new Date().toISOString();
  const binding = await insertThread(context, {
    thread: {
      organizationId,
      appId,
      agentId: input.agentId,
      threadId,
    },
    workspace: input.workspace,
    agentId: input.agentId,
    ...(input.persona ? { persona: input.persona } : {}),
    defaultMode: input.mode,
    ...(input.model ? { defaultModel: input.model } :
      context.env.FLARY_DEFAULT_MODEL && parseFlueModelSpecifier(context.env.FLARY_DEFAULT_MODEL)
        ? { defaultModel: parseFlueModelSpecifier(context.env.FLARY_DEFAULT_MODEL) }
        : {}),
    defaultThinkingLevel: input.thinkingLevel,
    connectionIds: input.connectionIds,
    createdBy: { id: session.user.id, kind: "user", version: "1" },
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  return context.json({ binding }, 201);
});

app.get("/api/apps/:appId/threads/:threadId", async (context) => {
  const loaded = await loadThreadRow(
    context,
    context.req.param("appId"),
    context.req.param("threadId"),
  );
  return context.json({ binding: loaded.binding });
});

app.post("/api/apps/:appId/threads/:threadId/archive", async (context) => {
  const loaded = await loadThreadRow(
    context,
    context.req.param("appId"),
    context.req.param("threadId"),
  );
  const now = new Date();
  await createDb(context.env.DB)
    .update(flaryThread)
    .set({ status: "archived", archivedAt: now, updatedAt: now })
    .where(eq(flaryThread.id, loaded.row.id));
  return context.json({
    ok: true,
    binding: ThreadBindingSchema.parse({
      ...loaded.binding,
      status: "archived",
      updatedAt: now.toISOString(),
    }),
  });
});

app.post("/api/apps/:appId/threads/:threadId/fork", async (context) => {
  const loaded = await loadThreadRow(
    context,
    context.req.param("appId"),
    context.req.param("threadId"),
  );
  const input = ThreadForkRequestSchema.parse(await readJson<unknown>(context));
  const now = new Date().toISOString();
  const threadId = input.threadId ?? `thread_${crypto.randomUUID().replaceAll("-", "")}`;
  const binding = await insertThread(context, {
    ...loaded.binding,
    thread: { ...loaded.binding.thread, threadId },
    ...(input.mode ? { defaultMode: input.mode } : {}),
    ...(input.model ? { defaultModel: input.model } : {}),
    ...(input.thinkingLevel ? { defaultThinkingLevel: input.thinkingLevel } : {}),
    parentThread: loaded.binding.thread,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  return context.json({ binding }, 201);
});

app.post("/api/apps/:appId/threads/:threadId/mode", async (context) => {
  const loaded = await loadThreadRow(
    context,
    context.req.param("appId"),
    context.req.param("threadId"),
  );
  const input = ThreadModeRequestSchema.parse(await readJson<unknown>(context));
  const now = new Date();
  await createDb(context.env.DB)
    .update(flaryThread)
    .set({ defaultMode: input.mode, updatedAt: now })
    .where(eq(flaryThread.id, loaded.row.id));
  const binding = { ...loaded.binding, defaultMode: input.mode, updatedAt: now.toISOString() };
  if (context.env.FLUE_FLARY_THREAD_AGENT) {
    await threadStub(context.env, loaded.binding).initializeBinding(binding);
  }
  return context.json({ binding });
});

app.post("/api/apps/:appId/threads/:threadId/connections", async (context) => {
  const loaded = await loadThreadRow(
    context,
    context.req.param("appId"),
    context.req.param("threadId"),
  );
  const input = ThreadConnectionsRequestSchema.parse(await readJson<unknown>(context));
  await assertThreadConnections(
    context,
    loaded.binding.thread.organizationId,
    loaded.binding.thread.appId,
    loaded.session.user.id,
    input.connectionIds,
  );
  const db = createDb(context.env.DB);
  const now = new Date();
  await db
    .update(flaryThread)
    .set({ connectionIdsJson: JSON.stringify(input.connectionIds), updatedAt: now })
    .where(eq(flaryThread.id, loaded.row.id));
  const binding = { ...loaded.binding, connectionIds: input.connectionIds, updatedAt: now.toISOString() };
  if (context.env.FLUE_FLARY_THREAD_AGENT) {
    await threadStub(context.env, loaded.binding).initializeBinding(binding);
  }
  return context.json({ binding });
});

app.get("/api/apps/:appId/threads/:threadId/approvals", async (context) => {
  const loaded = await loadThreadRow(
    context,
    context.req.param("appId"),
    context.req.param("threadId"),
  );
  const approvals = context.env.FLUE_FLARY_THREAD_AGENT
    ? await threadStub(context.env, loaded.binding).listApprovals()
    : [];
  return context.json({ approvals });
});

app.post("/api/apps/:appId/threads/:threadId/approvals/:approvalId", async (context) => {
  const loaded = await loadThreadRow(
    context,
    context.req.param("appId"),
    context.req.param("threadId"),
  );
  const input = ApprovalDecisionSchema.parse({
    ...(await readJson<Record<string, unknown>>(context)),
    requestId: context.req.param("approvalId"),
  });
  if (!context.env.FLUE_FLARY_THREAD_AGENT) {
    throw new HTTPException(503, { message: "The Flue thread Durable Object binding is not configured" });
  }
  await threadStub(context.env, loaded.binding).decideApproval(input);
  return context.json({ ok: true });
});

app.get("/api/apps/:appId/threads/:threadId/user-input", async (context) => {
  const loaded = await loadThreadRow(
    context,
    context.req.param("appId"),
    context.req.param("threadId"),
  );
  if (!context.env.FLUE_FLARY_THREAD_AGENT) {
    return context.json({ requests: [] });
  }
  return context.json({
    requests: await threadStub(context.env, loaded.binding).listUserInput(),
  });
});

app.post(
  "/api/apps/:appId/threads/:threadId/user-input/:requestId",
  async (context) => {
    const loaded = await loadThreadRow(
      context,
      context.req.param("appId"),
      context.req.param("threadId"),
    );
    if (!context.env.FLUE_FLARY_THREAD_AGENT) {
      throw new HTTPException(503, {
        message: "The Flue thread Durable Object binding is not configured",
      });
    }
    const input = UserInputAnswerRequestSchema.parse(
      await readJson<unknown>(context),
    );
    const response = UserInputResponseSchema.parse({
      requestId: context.req.param("requestId"),
      answers: input.answers,
      ...(input.response ? { response: input.response } : {}),
      canceled: input.canceled,
      answeredBy: {
        id: loaded.session.user.id,
        kind: "user",
        version: "1",
      },
      answeredAt: new Date().toISOString(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    const resolved = await threadStub(
      context.env,
      loaded.binding,
    ).respondToUserInput(response);
    if (resolved.live) {
      return context.json({ live: true });
    }

    const message = frameRestoredUserInputResponse(
      UserInputRequestSchema.parse(resolved.record.request),
      response,
    );
    const requestUrl = new URL(context.req.raw.url);
    requestUrl.pathname = `/api/apps/${encodeURIComponent(
      loaded.binding.thread.appId,
    )}/threads/${encodeURIComponent(
      loaded.binding.thread.threadId,
    )}/messages`;
    const headers = new Headers(context.req.raw.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    const admitted = await app.fetch(
      new Request(requestUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          message,
          idempotencyKey: `input_${response.requestId}`,
        }),
      }),
      context.env,
      context.executionCtx,
    );
    if (!admitted.ok) return admitted;
    return context.json({
      live: false,
      admission: await admitted.json(),
    });
  },
);

app.get("/api/apps/:appId/threads/:threadId/cursor", async (context) => {
  const loaded = await loadThreadRow(
    context,
    context.req.param("appId"),
    context.req.param("threadId"),
  );
  if (!context.env.FLUE_FLARY_THREAD_AGENT) {
    throw new HTTPException(503, {
      message: "The Flue thread Durable Object binding is not configured",
    });
  }
  const state = ThreadOperationalStateSchema.parse(
    await threadStub(context.env, loaded.binding).readOperational(),
  );
  return context.json({ cursor: state.cursor });
});

app.get("/api/apps/:appId/threads/:threadId/history", async (context) => {
  const loaded = await loadThreadRow(
    context,
    context.req.param("appId"),
    context.req.param("threadId"),
  );
  const limit = context.req.query("limit");
  try {
    return context.json(
      await listThreadHistory(
        context.env,
        loaded.binding,
        ThreadHistoryListInputSchema.parse(limit ? { limit } : {}),
      ),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "history_unavailable") {
      throw new HTTPException(503, { message: "History is not configured" });
    }
    throw error;
  }
});

app.post("/api/apps/:appId/threads/:threadId/history/diff", async (context) => {
  const loaded = await loadThreadRow(
    context,
    context.req.param("appId"),
    context.req.param("threadId"),
  );
  try {
    return context.json(
      await diffThreadHistory(
        context.env,
        loaded.binding,
        ThreadHistoryDiffInputSchema.parse(await readJson<unknown>(context)),
      ),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "history_unavailable") {
      throw new HTTPException(503, { message: "History is not configured" });
    }
    throw error;
  }
});

app.get("/api/apps/:appId/threads/:threadId/recall/search", async (context) => {
  const loaded = await loadThreadRow(
    context,
    context.req.param("appId"),
    context.req.param("threadId"),
  );
  const query = context.req.query("query");
  if (!query) throw new HTTPException(400, { message: "query is required" });
  const kinds = context.req.query("kinds");
  const mode = context.req.query("mode");
  const limit = context.req.query("limit");
  const input = ThreadRecallSearchInputSchema.parse({
    query,
    ...(mode ? { mode } : {}),
    ...(kinds ? { kinds: kinds.split(",").filter(Boolean) } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
  });
  try {
    return context.json(await searchThreadRecall(context.env, loaded.binding, input));
  } catch (error) {
    if (error instanceof Error && error.message === "recall_unavailable") {
      throw new HTTPException(503, { message: "Recall is not configured" });
    }
    throw error;
  }
});

app.post("/api/apps/:appId/threads/:threadId/recall/open", async (context) => {
  const loaded = await loadThreadRow(
    context,
    context.req.param("appId"),
    context.req.param("threadId"),
  );
  const input = ThreadRecallOpenInputSchema.parse(await readJson<unknown>(context));
  try {
    const document = await openThreadRecall(context.env, loaded.binding, input);
    if (!document) throw new HTTPException(404, { message: "Recall document not found" });
    return context.json({ document });
  } catch (error) {
    if (error instanceof Error && error.message === "recall_unavailable") {
      throw new HTTPException(503, { message: "Recall is not configured" });
    }
    throw error;
  }
});

app.post("/api/apps/:appId/threads/:threadId/messages", async (context) => {
  const loaded = await loadThreadRow(
    context,
    context.req.param("appId"),
    context.req.param("threadId"),
  );
  if (loaded.binding.status !== "active") {
    throw new HTTPException(409, { message: "Archived threads cannot receive messages" });
  }
  const input = ThreadMessageRequestSchema.parse(await readJson<unknown>(context));
  const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
  const db = createDb(context.env.DB);
  const existing = await db
    .select()
    .from(flaryThreadSubmission)
    .where(
      and(
        eq(flaryThreadSubmission.organizationId, loaded.organizationId),
        eq(flaryThreadSubmission.appId, loaded.binding.thread.appId),
        eq(flaryThreadSubmission.agentId, loaded.binding.thread.agentId),
        eq(flaryThreadSubmission.threadId, loaded.binding.thread.threadId),
        eq(flaryThreadSubmission.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (existing[0]?.submissionId && existing[0].streamUrl) {
    return context.json(
      {
        streamUrl: existing[0].streamUrl,
        offset: existing[0].flueOffset ?? "0",
        submissionId: existing[0].submissionId,
        duplicate: true,
      },
      202,
    );
  }
  if (existing[0]) {
    throw new HTTPException(409, {
      message: "This submission is still being admitted",
    });
  }
  const selectedModel =
    input.model ??
    loaded.binding.defaultModel ??
    ((context.env.FLARY_DEFAULT_MODEL
      ? parseFlueModelSpecifier(context.env.FLARY_DEFAULT_MODEL)
      : undefined) ?? {
      provider: "cloudflare",
      model: "@cf/meta/llama-3.1-8b-instruct",
    });
  const selectedThinkingLevel =
    input.thinkingLevel ?? loaded.binding.defaultThinkingLevel;
  const provider = ProviderKindSchema.safeParse(selectedModel.provider);
  if (!provider.success) {
    return context.json(
      {
        error: {
          type: "provider_not_supported",
          message: `Provider '${selectedModel.provider}' is not supported by this Flary deployment.`,
        },
      },
      422,
    );
  }
  const prepared = await prepareAdmittedFlueModel(
    context.env,
    loaded.binding,
    selectedModel,
    loaded.session.user.id,
  );
  if (!prepared) {
    return context.json(
      {
        error: {
          type: "provider_credentials_missing",
          message: `Flary could not prepare a trusted credential for provider '${selectedModel.provider}'.`,
          provider: selectedModel.provider,
        },
      },
      424,
    );
  }
  const admissionId = crypto.randomUUID();
  await db.insert(flaryThreadSubmission).values({
    id: admissionId,
    organizationId: loaded.organizationId,
    userId: loaded.session.user.id,
    appId: loaded.binding.thread.appId,
    agentId: loaded.binding.thread.agentId,
    threadId: loaded.binding.thread.threadId,
    modelJson: selectedModel ? JSON.stringify(selectedModel) : null,
    thinkingLevel: selectedThinkingLevel ?? null,
    cacheRetention: input.cacheRetention,
    credentialConnectionId: prepared.credential.connectionId ?? null,
    credentialSource: prepared.credential.source,
    billingMode: prepared.credential.billingMode,
    provider: prepared.credential.provider,
    credentialVersion: prepared.credential.version,
    credentialGeneration: prepared.credential.generation,
    credentialConnectionRef: prepared.credential.connectionRef,
    idempotencyKey,
    // Flue's initializer reads the pending record before it starts the
    // submission. Keep this row until admission has returned so recovery can
    // reuse the exact model and thinking values.
    status: "processing",
  });

  const headers = new Headers(context.req.raw.headers);
  headers.set("content-type", "application/json");
  headers.set("x-flary-admission-id", admissionId);
  headers.delete("content-length");
  headers.delete("host");
  const target = `/agents/flary-thread/${encodeURIComponent(threadName(loaded.binding.thread))}`;
  const response = await flueApp.fetch(
    new Request(`https://flue.internal${target}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: input.message,
        images: input.images,
        model: prepared.model,
        ...(selectedThinkingLevel
          ? { thinkingLevel: normalizeFlueThinkingLevel(selectedThinkingLevel) }
          : {}),
        cacheRetention: input.cacheRetention,
      }),
    }),
    context.env,
    context.executionCtx,
  );
  if (!response.ok) {
    await db
      .update(flaryThreadSubmission)
      .set({
        status: "failed",
        errorCode: "flue_admission_failed",
        settledAt: new Date(),
      })
      .where(
        and(
          eq(flaryThreadSubmission.id, admissionId),
          eq(flaryThreadSubmission.status, "processing"),
        ),
      );
    return response;
  }
  let admitted: { streamUrl?: string; offset?: string; submissionId?: string } = {};
  try {
    admitted = (await response.clone().json()) as typeof admitted;
  } catch {
    // Return the Flue response even when a future adapter changes its body.
  }
  await db
    .update(flaryThreadSubmission)
    .set({
      status: "admitted",
      streamUrl: admitted.streamUrl ?? null,
      flueOffset: admitted.offset ?? "0",
      submissionId: admitted.submissionId ?? null,
    })
    .where(
      and(
        eq(flaryThreadSubmission.id, admissionId),
        eq(flaryThreadSubmission.status, "processing"),
      ),
    );
  return response;
});

async function loadAppConnection(
  context: Context<AppContext>,
  appId: string,
  connectionId: string,
) {
  const { session, organizationId } = await requireAppMember(context, appId);
  const db = createDb(context.env.DB);
  const rows = await db
    .select()
    .from(flaryConnection)
    .where(
      and(
        eq(flaryConnection.id, connectionId),
        eq(flaryConnection.appId, appId),
        eq(flaryConnection.organizationId, organizationId),
      ),
    )
    .limit(1);
  const connection = rows[0];
  if (!connection) {
    throw new HTTPException(404, { message: "Connection not found" });
  }
  if (
    connection.billingMode === "subscription" &&
    connection.ownerUserId !== session.user.id
  ) {
    throw new HTTPException(404, { message: "Connection not found" });
  }
  return { db, session, organizationId, connection };
}

type FlaryConnectionRow = typeof flaryConnection.$inferSelect;

function publicConnection(
  row: FlaryConnectionRow,
  ownerName?: string | null,
) {
  return ConnectionSchema.parse({
    id: row.id,
    appId: row.appId,
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug,
    provider: row.provider,
    type: row.type,
    protocol: row.protocol,
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(row.docsUrl ? { docsUrl: row.docsUrl } : {}),
    authType: row.authType,
    billingMode: row.billingMode,
    ...(row.authHeader ? { authHeader: row.authHeader } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.iconUrl ? { iconUrl: row.iconUrl } : {}),
    status: row.status,
    createdBy: row.createdBy,
    ownerUserId: row.ownerUserId,
    ownerName: ownerName ?? null,
    credentialSubject: row.credentialSubject,
    credentialScopes: JSON.parse(row.credentialScopesJson || "[]"),
    credentialExpiresAt: row.credentialExpiresAt?.toISOString() ?? null,
    credentialRefreshedAt: row.credentialRefreshedAt?.toISOString() ?? null,
    credentialRevokedAt: row.credentialRevokedAt?.toISOString() ?? null,
    createdAt: (row.createdAt ?? new Date()).toISOString(),
    updatedAt: (row.updatedAt ?? new Date()).toISOString(),
  });
}

// Connection metadata is safe to expose. Secret values are only accepted by
// the separate write endpoint below and are never returned by these routes.
app.get("/api/apps/:appId/connections", async (context) => {
  const appId = context.req.param("appId");
  const { session, organizationId } = await requireAppMember(context, appId);
  const db = createDb(context.env.DB);
  const connections = await db
    .select()
    .from(flaryConnection)
    .where(
      and(
        eq(flaryConnection.appId, appId),
        eq(flaryConnection.organizationId, organizationId),
        or(
          ne(flaryConnection.billingMode, "subscription"),
          eq(flaryConnection.ownerUserId, session.user.id),
        ),
      ),
    )
    .orderBy(asc(flaryConnection.name));
  return context.json({
    connections: connections.map((connection) =>
      publicConnection(
        connection,
        connection.ownerUserId === session.user.id
          ? session.user.name
          : null,
      ),
    ),
  });
});

app.post("/api/apps/:appId/connections", async (context) => {
  const appId = context.req.param("appId");
  const { session, organizationId } = await requireAppMember(context, appId);
  const input = ConnectionCreateInputSchema.parse(
    await readJson<unknown>(context),
  );
  const db = createDb(context.env.DB);
  const existing = await db
    .select({ id: flaryConnection.id })
    .from(flaryConnection)
    .where(
      and(
        eq(flaryConnection.appId, appId),
        eq(flaryConnection.slug, input.slug),
      ),
    )
    .limit(1);
  if (existing[0]) {
    throw new HTTPException(409, {
      message: `Connection slug ${input.slug} already exists`,
    });
  }

  const id = crypto.randomUUID();
  await db.insert(flaryConnection).values({
    id,
    appId,
    organizationId,
    name: input.name,
    slug: input.slug,
    provider: input.provider,
    type: input.type,
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    docsUrl: input.docsUrl,
    authType: input.authType,
    billingMode:
      input.billingMode ??
      (input.authType === "oauth2" ? "subscription" : "byok"),
    authHeader: input.authHeader,
    description: input.description,
    iconUrl: input.iconUrl,
    status: "needs_auth",
    ownerUserId:
      (input.billingMode ??
        (input.authType === "oauth2" ? "subscription" : "byok")) ===
      "subscription"
        ? session.user.id
        : null,
    createdBy: session.user.id,
  });
  const connection = await loadAppConnection(context, appId, id);
  return context.json(
    {
      connection: publicConnection(
        connection.connection,
        connection.connection.ownerUserId === session.user.id
          ? session.user.name
          : null,
      ),
    },
    201,
  );
});

app.get(
  "/api/apps/:appId/connections/:connectionId",
  async (context) => {
    const appId = context.req.param("appId");
    const connectionId = context.req.param("connectionId");
    const { db, session, connection } = await loadAppConnection(
      context,
      appId,
      connectionId,
    );
    const secrets = await db
      .select({
        id: secretEnvelope.id,
        connectionId: secretEnvelope.connectionId,
        name: secretEnvelope.name,
        scope: secretEnvelope.scope,
        version: secretEnvelope.version,
        keyId: secretEnvelope.keyId,
        description: secretEnvelope.description,
        expiresAt: secretEnvelope.expiresAt,
        createdAt: secretEnvelope.createdAt,
        updatedAt: secretEnvelope.updatedAt,
      })
      .from(secretEnvelope)
      .where(eq(secretEnvelope.connectionId, connectionId))
      .orderBy(asc(secretEnvelope.name));
    return context.json({
      connection: publicConnection(
        connection,
        connection.ownerUserId === session.user.id
          ? session.user.name
          : null,
      ),
      secrets,
    });
  },
);

app.post(
  "/api/apps/:appId/connections/:connectionId/secrets",
  async (context) => {
    const appId = context.req.param("appId");
    const connectionId = context.req.param("connectionId");
    const { db, organizationId, connection } = await loadAppConnection(
      context,
      appId,
      connectionId,
    );
    const input = ConnectionSecretInputSchema.parse(
      await readJson<unknown>(context),
    );
    const keyConfig = context.env.FLARY_TOKEN_ENCRYPTION_KEY_B64;
    if (!keyConfig) {
      throw new HTTPException(503, {
        message: "Secret storage is not configured",
      });
    }

    const associatedData = connectionSecretAssociatedData(
      organizationId,
      connectionId,
      input.name,
    );
    const encrypted = await encryptToken(input.value, keyConfig, associatedData);
    const existing = await db
      .select({ id: secretEnvelope.id, version: secretEnvelope.version })
      .from(secretEnvelope)
      .where(
        and(
          eq(secretEnvelope.connectionId, connectionId),
          eq(secretEnvelope.name, input.name),
        ),
      )
      .limit(1);
    const current = existing[0];
    const secretId = current?.id ?? crypto.randomUUID();
    const version = (current?.version ?? 0) + 1;
    const now = new Date();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

    await db
      .insert(secretEnvelope)
      .values({
        id: secretId,
        connectionId,
        organizationId,
        name: input.name,
        scope: input.scope,
        version,
        keyId: "flary-token-encryption-key",
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        description: input.description ?? null,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [secretEnvelope.connectionId, secretEnvelope.name],
        set: {
          organizationId,
          scope: input.scope,
          version,
          keyId: "flary-token-encryption-key",
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          description: input.description ?? null,
          expiresAt,
          updatedAt: now,
        },
      });
    await db
      .update(flaryConnection)
      .set({ status: "configured", updatedAt: now })
      .where(eq(flaryConnection.id, connection.id));

    const saved = await db
      .select({
        id: secretEnvelope.id,
        connectionId: secretEnvelope.connectionId,
        name: secretEnvelope.name,
        scope: secretEnvelope.scope,
        version: secretEnvelope.version,
        keyId: secretEnvelope.keyId,
        description: secretEnvelope.description,
        expiresAt: secretEnvelope.expiresAt,
        createdAt: secretEnvelope.createdAt,
        updatedAt: secretEnvelope.updatedAt,
      })
      .from(secretEnvelope)
      .where(eq(secretEnvelope.id, secretId))
      .limit(1);
    return context.json({ ok: true, secret: saved[0] });
  },
);

app.delete(
  "/api/apps/:appId/connections/:connectionId/secrets/:secretName",
  async (context) => {
    const appId = context.req.param("appId");
    const connectionId = context.req.param("connectionId");
    const secretName = z.string().min(1).max(200).parse(
      context.req.param("secretName"),
    );
    const { db, connection } = await loadAppConnection(
      context,
      appId,
      connectionId,
    );
    await db
      .delete(secretEnvelope)
      .where(
        and(
          eq(secretEnvelope.connectionId, connectionId),
          eq(secretEnvelope.name, secretName),
        ),
      );
    const remaining = await db
      .select({ id: secretEnvelope.id })
      .from(secretEnvelope)
      .where(eq(secretEnvelope.connectionId, connectionId))
      .limit(1);
    await db
      .update(flaryConnection)
      .set({
        status:
          connection.authType === "none"
            ? "configured"
            : remaining[0]
              ? "configured"
              : "needs_auth",
        updatedAt: new Date(),
      })
      .where(eq(flaryConnection.id, connectionId));
    return context.json({ ok: true });
  },
);

app.delete(
  "/api/apps/:appId/connections/:connectionId",
  async (context) => {
    const appId = context.req.param("appId");
    const connectionId = context.req.param("connectionId");
    const { db, connection } = await loadAppConnection(
      context,
      appId,
      connectionId,
    );
    await db.delete(flaryConnection).where(eq(flaryConnection.id, connection.id));
    return context.json({ ok: true });
  },
);

app.post(
  "/api/apps/:appId/connections/:connectionId/disconnect",
  async (context) => {
    const appId = context.req.param("appId");
    const connectionId = context.req.param("connectionId");
    const { session, organizationId, connection } = await loadAppConnection(
      context,
      appId,
      connectionId,
    );
    if (
      connection.billingMode !== "subscription" ||
      connection.authType !== "oauth2"
    ) {
      throw new HTTPException(409, {
        message: "Only subscription OAuth connections can be disconnected",
      });
    }
    await disconnectSubscriptionCredential(context.env, {
      organizationId,
      userId: session.user.id,
      connectionId,
      provider: SubscriptionProviderSchema.parse(connection.provider),
    });
    return context.json({ ok: true });
  },
);

app.post("/api/apps/:appId/provider-oauth/start", async (context) => {
  const appId = context.req.param("appId");
  const { session, organizationId } = await requireAppMember(context, appId);
  const input = ProviderOAuthStartInputSchema.parse(
    await readJson<unknown>(context),
  );
  const oauth = await startCloudProviderOAuth(context.env, {
    appId,
    organizationId,
    userId: session.user.id,
    provider: input.provider,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.method ? { method: input.method } : {}),
  });
  return context.json({ oauth }, 201);
});

app.get(
  "/api/apps/:appId/provider-oauth/:sessionId",
  async (context) => {
    const appId = context.req.param("appId");
    const { session, organizationId } = await requireAppMember(context, appId);
    const oauth = await getCloudProviderOAuth(context.env, {
      appId,
      organizationId,
      userId: session.user.id,
      sessionId: context.req.param("sessionId"),
      poll: context.req.query("poll") === "true",
    });
    return context.json({ oauth });
  },
);

app.post(
  "/api/apps/:appId/provider-oauth/:sessionId/complete",
  async (context) => {
    const appId = context.req.param("appId");
    const { session, organizationId } = await requireAppMember(context, appId);
    const input = ProviderOAuthCompleteInputSchema.parse(
      await readJson<unknown>(context),
    );
    const oauth = await completeCloudProviderOAuth(context.env, {
      appId,
      organizationId,
      userId: session.user.id,
      sessionId: context.req.param("sessionId"),
      authorizationResult: input.authorizationResult,
    });
    return context.json({ oauth });
  },
);

app.post(
  "/api/apps/:appId/provider-oauth/:sessionId/cancel",
  async (context) => {
    const appId = context.req.param("appId");
    const { session, organizationId } = await requireAppMember(context, appId);
    const oauth = await cancelCloudProviderOAuth(context.env, {
      appId,
      organizationId,
      userId: session.user.id,
      sessionId: context.req.param("sessionId"),
    });
    return context.json({ oauth });
  },
);

function workspaceFilesystemStub(
  env: Env,
  organizationId: string,
  appId: string,
  projectId: string,
  workspaceId: string,
  branch = "main",
): DurableObjectStub {
  const id = env.PROJECT_WORKSPACES.idFromName(
    [organizationId, appId, projectId, workspaceId, ...(branch === "main" ? [] : [branch])].join(":"),
  );
  return env.PROJECT_WORKSPACES.get(id);
}

async function workspaceFilesystemRequest(
  context: Context<AppContext>,
  operation: "write" | "read" | "stat" | "list" | "delete" | "move" | "edit",
): Promise<Response> {
  const appId = z.string().min(1).parse(context.req.param("appId"));
  const projectId = z.string().min(1).parse(context.req.param("projectId"));
  const workspaceId = StorageIdentifierSchema.parse(
    context.req.param("workspaceId"),
  );
  const branch = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .default("main")
    .parse(context.req.query("branch") ?? "main");
  const { organizationId } = await requireAppMember(context, appId);
  const input = await readJson<unknown>(context);
  return workspaceFilesystemStub(
    context.env,
    organizationId,
    appId,
    projectId,
    workspaceId,
    branch,
  ).fetch(
    new Request(`https://workspace-filesystem/${operation}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-flary-organization-id": organizationId,
        "x-flary-app-id": appId,
        "x-flary-project-id": projectId,
        "x-flary-workspace-id": workspaceId,
        "x-flary-branch": branch,
      },
      body: JSON.stringify(input),
    }),
  );
}

app.get("/api/apps/:appId/prompts", async (context) => {
  const { organizationId } = await requireAppMember(
    context,
    context.req.param("appId")
  );
  const db = createDb(context.env.DB);
  const rows = await db
    .select({
      id: prompt.id,
      slug: prompt.slug,
      sourceHash: prompt.sourceHash,
      sourceCommit: prompt.sourceCommit,
      model: prompt.model,
      thinking: prompt.thinking,
      createdAt: prompt.createdAt,
      updatedAt: prompt.updatedAt,
    })
    .from(prompt)
    .innerJoin(flaryApp, eq(flaryApp.id, prompt.appId))
    .where(
      and(
        eq(prompt.appId, context.req.param("appId")),
        eq(flaryApp.organizationId, organizationId)
      )
    )
    .orderBy(asc(prompt.slug));
  return context.json({ prompts: rows });
});

app.post("/api/apps/:appId/prompts", async (context) => {
  const appId = context.req.param("appId");
  const { session } = await requireAppMember(context, appId);
  const input = promptInputSchema.parse(await readJson<unknown>(context));
  const computedSourceHash = await sha256Hex(input.source);
  if (computedSourceHash !== input.sourceHash) {
    throw new HTTPException(400, {
      message: "sourceHash does not match source content",
    });
  }
  const db = createDb(context.env.DB);
  const sourceKey = `prompts/${appId}/${input.slug}/${input.sourceHash}.prompt.md`;
  const existing = await db
    .select({
      id: prompt.id,
      sourceHash: prompt.sourceHash,
      sourceKey: prompt.sourceKey,
    })
    .from(prompt)
    .where(and(eq(prompt.appId, appId), eq(prompt.slug, input.slug)))
    .limit(1);
  const existingPrompt = existing[0];

  if (existingPrompt?.sourceHash === input.sourceHash) {
    const currentRevision = await db
      .select({
        id: promptRevision.id,
        revision: promptRevision.revision,
        sourceKey: promptRevision.sourceKey,
        sourceHash: promptRevision.sourceHash,
      })
      .from(promptRevision)
      .where(eq(promptRevision.promptId, existingPrompt.id))
      .orderBy(desc(promptRevision.revision))
      .limit(1);
    const revision = currentRevision[0];
    return context.json({
      ok: true,
      created: false,
      promptId: existingPrompt.id,
      revisionId: revision?.id,
      revision: revision?.revision,
      sourceKey: revision?.sourceKey ?? existingPrompt.sourceKey,
      sourceHash: revision?.sourceHash ?? existingPrompt.sourceHash,
    });
  }

  await context.env.WORKSPACE_BLOBS.put(sourceKey, input.source, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { sourceHash: input.sourceHash, slug: input.slug },
  });

  let promptId = existingPrompt?.id;
  if (!promptId) {
    promptId = crypto.randomUUID();
    await db.insert(prompt).values({
      id: promptId,
      appId,
      slug: input.slug,
      sourceHash: input.sourceHash,
      sourceKey,
      sourceCommit: input.sourceCommit,
      model: input.model,
      thinking: input.thinking,
    });
  }

  const latestRevision = await db
    .select({ revision: promptRevision.revision })
    .from(promptRevision)
    .where(eq(promptRevision.promptId, promptId))
    .orderBy(desc(promptRevision.revision))
    .limit(1);
  const revision = (latestRevision[0]?.revision ?? 0) + 1;
  const revisionId = crypto.randomUUID();
  await db.insert(promptRevision).values({
    id: revisionId,
    promptId,
    revision,
    sourceHash: input.sourceHash,
    sourceKey,
    sourceCommit: input.sourceCommit,
    model: input.model,
    thinking: input.thinking,
    createdBy: session.user.id,
  });

  const values = {
    sourceHash: input.sourceHash,
    sourceKey,
    sourceCommit: input.sourceCommit,
    model: input.model,
    thinking: input.thinking,
    updatedAt: new Date(),
  };
  if (existingPrompt) {
    await db.update(prompt).set(values).where(eq(prompt.id, existingPrompt.id));
  }
  return context.json({
    ok: true,
    created: true,
    promptId,
    revisionId,
    revision,
    sourceKey,
    sourceHash: input.sourceHash,
  });
});

app.get("/api/apps/:appId/prompts/:slug/revisions", async (context) => {
  const appId = context.req.param("appId");
  await requireAppMember(context, appId);
  const db = createDb(context.env.DB);
  const rows = await db
    .select({
      id: promptRevision.id,
      revision: promptRevision.revision,
      sourceHash: promptRevision.sourceHash,
      sourceKey: promptRevision.sourceKey,
      sourceCommit: promptRevision.sourceCommit,
      model: promptRevision.model,
      thinking: promptRevision.thinking,
      createdBy: promptRevision.createdBy,
      createdAt: promptRevision.createdAt,
    })
    .from(promptRevision)
    .innerJoin(prompt, eq(prompt.id, promptRevision.promptId))
    .where(
      and(eq(prompt.appId, appId), eq(prompt.slug, context.req.param("slug")))
    )
    .orderBy(desc(promptRevision.revision));
  return context.json({ revisions: rows });
});

app.get(
  "/api/apps/:appId/prompts/:slug/revisions/:revisionId/source",
  async (context) => {
    const appId = context.req.param("appId");
    await requireAppMember(context, appId);
    const db = createDb(context.env.DB);
    const rows = await db
      .select({
        id: promptRevision.id,
        revision: promptRevision.revision,
        sourceHash: promptRevision.sourceHash,
        sourceKey: promptRevision.sourceKey,
        sourceCommit: promptRevision.sourceCommit,
        model: promptRevision.model,
        thinking: promptRevision.thinking,
        createdBy: promptRevision.createdBy,
        createdAt: promptRevision.createdAt,
      })
      .from(promptRevision)
      .innerJoin(prompt, eq(prompt.id, promptRevision.promptId))
      .where(
        and(
          eq(prompt.appId, appId),
          eq(prompt.slug, context.req.param("slug")),
          eq(promptRevision.id, context.req.param("revisionId"))
        )
      )
      .limit(1);
    const revision = rows[0];
    if (!revision) {
      throw new HTTPException(404, { message: "Prompt revision not found" });
    }
    const object = await context.env.WORKSPACE_BLOBS.get(revision.sourceKey);
    if (!object) {
      throw new HTTPException(410, {
        message: "Prompt revision source is unavailable",
      });
    }
    return context.json({
      revision,
      source: await object.text(),
    });
  }
);

app.get("/api/apps/:appId/prompts/:slug/variants", async (context) => {
  const appId = context.req.param("appId");
  await requireAppMember(context, appId);
  const db = createDb(context.env.DB);
  const rows = await db
    .select({
      id: promptVariant.id,
      rolloutId: promptVariant.rolloutId,
      scope: promptVariant.scope,
      variantId: promptVariant.variantId,
      revisionId: promptVariant.revisionId,
      allocationBasisPoints: promptVariant.allocationBasisPoints,
      enabled: promptVariant.enabled,
      createdBy: promptVariant.createdBy,
      createdAt: promptVariant.createdAt,
    })
    .from(promptVariant)
    .innerJoin(prompt, eq(prompt.id, promptVariant.promptId))
    .where(
      and(eq(prompt.appId, appId), eq(prompt.slug, context.req.param("slug")))
    )
    .orderBy(asc(promptVariant.rolloutId), asc(promptVariant.variantId));
  return context.json({ variants: rows });
});

app.post("/api/apps/:appId/prompts/:slug/variants/select", async (context) => {
  const appId = context.req.param("appId");
  await requireAppMember(context, appId);
  const input = promptVariantSelectionInputSchema.parse(
    await readJson<unknown>(context)
  );
  const db = createDb(context.env.DB);
  const rows = await db
    .select({
      promptId: prompt.id,
      rolloutId: promptVariant.rolloutId,
      scope: promptVariant.scope,
      variantId: promptVariant.variantId,
      revisionId: promptVariant.revisionId,
      allocationBasisPoints: promptVariant.allocationBasisPoints,
      enabled: promptVariant.enabled,
    })
    .from(promptVariant)
    .innerJoin(prompt, eq(prompt.id, promptVariant.promptId))
    .where(
      and(
        eq(prompt.appId, appId),
        eq(prompt.slug, context.req.param("slug")),
        eq(promptVariant.rolloutId, input.rolloutId)
      )
    )
    .orderBy(asc(promptVariant.variantId));
  if (!rows[0]) {
    throw new HTTPException(404, { message: "Prompt rollout not found" });
  }
  const result = await selectPromptVariantWithTelemetry(
    {
      rolloutId: input.rolloutId,
      promptId: rows[0].promptId,
      scope: rows[0].scope as
        | "global"
        | "organization"
        | "project"
        | "user"
        | "session"
        | "request",
      variants: rows.map((row) => ({
        id: row.variantId,
        revisionId: row.revisionId,
        allocationBasisPoints: row.allocationBasisPoints,
        enabled: row.enabled,
      })),
    },
    input.assignment,
    {
      traceContext: input.traceContext ?? createTraceContext(),
      runId: input.runId,
    },
    input.override
  );
  return context.json(result);
});

app.post("/api/apps/:appId/prompts/:slug/variants", async (context) => {
  const appId = context.req.param("appId");
  const { session } = await requireAppMember(context, appId);
  const input = promptVariantInputSchema.parse(
    await readJson<unknown>(context)
  );
  const db = createDb(context.env.DB);
  const promptRow = await db
    .select({ id: prompt.id })
    .from(prompt)
    .where(
      and(eq(prompt.appId, appId), eq(prompt.slug, context.req.param("slug")))
    )
    .limit(1);
  if (!promptRow[0])
    throw new HTTPException(404, { message: "Prompt not found" });

  const revisionIds = new Set(
    (
      await db
        .select({ id: promptRevision.id })
        .from(promptRevision)
        .where(eq(promptRevision.promptId, promptRow[0].id))
    ).map((row) => row.id)
  );
  if (input.variants.some((variant) => !revisionIds.has(variant.revisionId))) {
    throw new HTTPException(400, {
      message: "Every variant revision must belong to this prompt",
    });
  }

  const existing = await db
    .select({ id: promptVariant.id })
    .from(promptVariant)
    .where(
      and(
        eq(promptVariant.promptId, promptRow[0].id),
        eq(promptVariant.rolloutId, input.rolloutId)
      )
    )
    .limit(1);
  if (existing[0]) {
    throw new HTTPException(409, {
      message: "This rollout already exists; create a new rollout ID",
    });
  }

  await db.insert(promptVariant).values(
    input.variants.map((variant) => ({
      id: crypto.randomUUID(),
      promptId: promptRow[0].id,
      rolloutId: input.rolloutId,
      scope: input.scope,
      variantId: variant.id,
      revisionId: variant.revisionId,
      allocationBasisPoints: variant.allocationBasisPoints,
      enabled: variant.enabled,
      createdBy: session.user.id,
    }))
  );
  return context.json({ ok: true, rolloutId: input.rolloutId }, 201);
});

app.post("/api/apps/:appId/executions", async (context) => {
  const appId = context.req.param("appId");
  const { organizationId } = await requireAppMember(context, appId);
  const input = CodeExecutionRequestSchema.parse(
    await readJson<unknown>(context)
  );
  const router = createCloudExecutionRouter(context.env, organizationId);
  const result = await router.execute(input);
  return context.json({ result }, result.status === "completed" ? 200 : 422);
});

app.post(
  "/api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/upload-ticket",
  async (context) => {
    const appId = context.req.param("appId");
    const projectId = context.req.param("projectId");
    const workspaceId = StorageIdentifierSchema.parse(
      context.req.param("workspaceId"),
    );
    const { organizationId } = await requireAppMember(context, appId);
    const input = WorkspaceUploadTicketRequestSchema.parse(
      await readJson<unknown>(context),
    );
    const response = await workspaceFilesystemStub(
      context.env,
      organizationId,
      appId,
      projectId,
      workspaceId,
    ).fetch(
      new Request("https://workspace-filesystem/upload-ticket", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-flary-organization-id": organizationId,
          "x-flary-app-id": appId,
          "x-flary-project-id": projectId,
          "x-flary-workspace-id": workspaceId,
        },
        body: JSON.stringify(input),
      }),
    );
    if (!response.ok) return response;
    const ticket = (await response.json()) as Record<string, unknown>;
    const uploadUrl = new URL(
      `/api/apps/${encodeURIComponent(appId)}/projects/${encodeURIComponent(
        projectId,
      )}/workspaces/${encodeURIComponent(workspaceId)}/files/upload`,
      requestOrigin(context.req.raw),
    );
    uploadUrl.searchParams.set("organizationId", organizationId);
    uploadUrl.searchParams.set("ticket", String(ticket.token));
    return context.json({ ...ticket, uploadUrl: uploadUrl.toString() });
  },
);

app.post(
  "/api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/download-ticket",
  async (context) => {
    const appId = context.req.param("appId");
    const projectId = context.req.param("projectId");
    const workspaceId = StorageIdentifierSchema.parse(
      context.req.param("workspaceId"),
    );
    const { organizationId } = await requireAppMember(context, appId);
    const input = WorkspaceDownloadTicketRequestSchema.parse(
      await readJson<unknown>(context),
    );
    const response = await workspaceFilesystemStub(
      context.env,
      organizationId,
      appId,
      projectId,
      workspaceId,
    ).fetch(
      new Request("https://workspace-filesystem/download-ticket", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-flary-organization-id": organizationId,
          "x-flary-app-id": appId,
          "x-flary-project-id": projectId,
          "x-flary-workspace-id": workspaceId,
        },
        body: JSON.stringify(input),
      }),
    );
    if (!response.ok) return response;
    const ticket = (await response.json()) as Record<string, unknown>;
    const downloadUrl = new URL(
      `/api/apps/${encodeURIComponent(appId)}/projects/${encodeURIComponent(
        projectId,
      )}/workspaces/${encodeURIComponent(workspaceId)}/files/download`,
      requestOrigin(context.req.raw),
    );
    downloadUrl.searchParams.set("organizationId", organizationId);
    downloadUrl.searchParams.set("ticket", String(ticket.token));
    return context.json({ ...ticket, downloadUrl: downloadUrl.toString() });
  },
);

app.put(
  "/api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/upload",
  async (context) => {
    const appId = context.req.param("appId");
    const projectId = context.req.param("projectId");
    const workspaceId = StorageIdentifierSchema.parse(
      context.req.param("workspaceId"),
    );
    const organizationId = StorageIdentifierSchema.parse(
      context.req.query("organizationId"),
    );
    const ticket = context.req.query("ticket");
    if (!ticket) throw new HTTPException(400, { message: "Transfer ticket is required" });
    return workspaceFilesystemStub(
      context.env,
      organizationId,
      appId,
      projectId,
      workspaceId,
    ).fetch(
      new Request(
        `https://workspace-filesystem/upload?ticket=${encodeURIComponent(ticket)}`,
        {
          method: "PUT",
          headers: {
            "x-flary-organization-id": organizationId,
            "x-flary-app-id": appId,
            "x-flary-project-id": projectId,
            "x-flary-workspace-id": workspaceId,
          },
          body: await context.req.raw.arrayBuffer(),
        },
      ),
    );
  },
);

app.get(
  "/api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/download",
  async (context) => {
    const appId = context.req.param("appId");
    const projectId = context.req.param("projectId");
    const workspaceId = StorageIdentifierSchema.parse(
      context.req.param("workspaceId"),
    );
    const organizationId = StorageIdentifierSchema.parse(
      context.req.query("organizationId"),
    );
    const ticket = context.req.query("ticket");
    if (!ticket) throw new HTTPException(400, { message: "Transfer ticket is required" });
    return workspaceFilesystemStub(
      context.env,
      organizationId,
      appId,
      projectId,
      workspaceId,
    ).fetch(
      new Request(
        `https://workspace-filesystem/download?ticket=${encodeURIComponent(ticket)}`,
        {
          headers: {
            "x-flary-organization-id": organizationId,
            "x-flary-app-id": appId,
            "x-flary-project-id": projectId,
            "x-flary-workspace-id": workspaceId,
          },
        },
      ),
    );
  },
);

app.post(
  "/api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/:operation",
  async (context) => {
    const operation = z
      .enum(["write", "read", "stat", "list", "delete", "move", "edit"])
      .parse(context.req.param("operation"));
    return workspaceFilesystemRequest(context, operation);
  },
);

app.get(
  "/api/apps/:appId/projects/:projectId/workspaces/:workspaceId/files/health",
  async (context) => {
    const appId = context.req.param("appId");
    const projectId = context.req.param("projectId");
    const workspaceId = StorageIdentifierSchema.parse(
      context.req.param("workspaceId"),
    );
    const { organizationId } = await requireAppMember(context, appId);
    return workspaceFilesystemStub(
      context.env,
      organizationId,
      appId,
      projectId,
      workspaceId,
    ).fetch(
      new Request("https://workspace-filesystem/health", {
        headers: {
          "x-flary-organization-id": organizationId,
          "x-flary-app-id": appId,
          "x-flary-project-id": projectId,
          "x-flary-workspace-id": workspaceId,
        },
      }),
    );
  },
);

app.get(
  "/api/organizations/:organizationId/cloudflare/connection",
  async (context) => {
    const organizationId = context.req.param("organizationId");
    const { session } = await requireOrganizationMember(
      context,
      organizationId
    );
    const db = createDb(context.env.DB);
    const row = await db
      .select({
        accountId: cloudflareConnection.accountId,
        accountName: cloudflareConnection.accountName,
        gatewayId: cloudflareConnection.gatewayId,
        accountOptionsJson: cloudflareConnection.accountOptionsJson,
        scope: cloudflareConnection.scope,
        updatedAt: cloudflareConnection.updatedAt,
      })
      .from(cloudflareConnection)
      .where(
        and(
          eq(cloudflareConnection.organizationId, organizationId),
          eq(cloudflareConnection.userId, session.user.id)
        )
      )
        .limit(1);
    if (!row[0]) {
      return context.json({
        connected: false,
        pending: false,
        oauthConfigured: isCloudflareOAuthConfigured(context.env),
      });
    }
    const accounts = parseCloudflareAccountOptions(row[0].accountOptionsJson);
    const connected = Boolean(
      row[0].accountId && row[0].gatewayId && row[0].accountName,
    );
    return context.json({
      connected,
      pending: !connected && accounts.length > 0,
      oauthConfigured: isCloudflareOAuthConfigured(context.env),
      accountId: row[0].accountId,
      accountName: row[0].accountName,
      gatewayId: row[0].gatewayId,
      accounts,
      scope: row[0].scope,
      updatedAt: row[0].updatedAt,
    });
  }
);

app.get("/api/cloudflare/oauth/start", async (context) => {
  const organizationId = context.req.query("organizationId");
  if (!organizationId)
    throw new HTTPException(400, { message: "organizationId is required" });
  const { session } = await requireOrganizationMember(context, organizationId);
  if (!isCloudflareOAuthConfigured(context.env)) {
    throw new HTTPException(503, {
      message: "Cloudflare OAuth is not configured",
    });
  }
  const state = crypto.randomUUID();
  const redirectUri = cloudflareOAuthRedirectUri(
    context.env,
    context.req.raw.url,
  );
  const db = createDb(context.env.DB);
  await db
    .delete(cloudflareOAuthState)
    .where(eq(cloudflareOAuthState.userId, session.user.id));
  await db.insert(cloudflareOAuthState).values({
    id: crypto.randomUUID(),
    userId: session.user.id,
    organizationId,
    stateHash: await hashOAuthState(state),
    redirectUri,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return context.redirect(
    buildCloudflareAuthorizationUrl(context.env, context.req.raw.url, state),
    302,
  );
});

app.get("/api/cloudflare/oauth/callback", async (context) => {
  const error = context.req.query("error");
  if (error)
    return cloudflareRedirect(context, { cloudflare: "error", reason: error });
  const code = context.req.query("code");
  const state = context.req.query("state");
  if (!code || !state)
    return cloudflareRedirect(context, {
      cloudflare: "error",
      reason: "missing_callback",
    });
  if (!isCloudflareOAuthConfigured(context.env)) {
    return cloudflareRedirect(context, {
      cloudflare: "error",
      reason: "oauth_not_configured",
    });
  }
  try {
    const db = createDb(context.env.DB);
    const stateHash = await hashOAuthState(state);
    const stateRows = await db
      .select()
      .from(cloudflareOAuthState)
      .where(eq(cloudflareOAuthState.stateHash, stateHash))
      .limit(1);
    const stateRow = stateRows[0];
    if (!stateRow || stateRow.expiresAt.getTime() < Date.now()) {
      return cloudflareRedirect(context, {
        cloudflare: "error",
        reason: "invalid_state",
      });
    }
    await db
      .delete(cloudflareOAuthState)
      .where(eq(cloudflareOAuthState.id, stateRow.id));

    const token = await exchangeCloudflareCode(
      context.env,
      code,
      context.req.raw.url,
    );
    const access = await encryptCloudflareToken(
      context.env,
      token.accessToken,
      stateRow.organizationId,
      stateRow.userId,
      "access",
    );
    const refresh = token.refreshToken
      ? await encryptCloudflareToken(
          context.env,
          token.refreshToken,
          stateRow.organizationId,
          stateRow.userId,
          "refresh",
        )
      : null;
    const accountOptions = await fetchCloudflareAccounts(token.accessToken);
    if (accountOptions.length === 0) {
      return cloudflareRedirect(context, {
        cloudflare: "error",
        reason: "no_accounts",
      });
    }

    const selectedAccount = accountOptions.length === 1 ? accountOptions[0] : null;
    const gatewayId = selectedAccount
      ? await ensureCloudflareGateway(
          token.accessToken,
          selectedAccount.id,
          stateRow.userId,
        )
      : null;
    const existing = await db
      .select({ id: cloudflareConnection.id })
      .from(cloudflareConnection)
      .where(
        and(
          eq(cloudflareConnection.organizationId, stateRow.organizationId),
          eq(cloudflareConnection.userId, stateRow.userId),
        ),
      )
      .limit(1);
    const connectionValues = {
      accountId: selectedAccount?.id ?? null,
      accountName: selectedAccount?.name ?? null,
      gatewayId,
      accountOptionsJson: JSON.stringify(accountOptions),
      accessTokenCiphertext: access.ciphertext,
      accessTokenIv: access.iv,
      refreshTokenCiphertext: refresh?.ciphertext ?? null,
      refreshTokenIv: refresh?.iv ?? null,
      accessTokenExpiresAt: token.accessTokenExpiresAt,
      scope: token.scope ?? cloudflareOAuthScopes(context.env).join(" "),
      updatedAt: new Date(),
    };
    if (existing[0]) {
      await db
        .update(cloudflareConnection)
        .set(connectionValues)
        .where(eq(cloudflareConnection.id, existing[0].id));
    } else {
      await db.insert(cloudflareConnection).values({
        id: crypto.randomUUID(),
        userId: stateRow.userId,
        organizationId: stateRow.organizationId,
        ...connectionValues,
      });
    }
    return cloudflareRedirect(context, {
      cloudflare: selectedAccount ? "connected" : "choose_account",
      organizationId: stateRow.organizationId,
    });
  } catch (cause) {
    console.error(
      "Cloudflare OAuth callback failed",
      cause instanceof Error ? cause.message : cause,
    );
    return cloudflareRedirect(context, {
      cloudflare: "error",
      reason: cloudflareErrorReason(cause),
    });
  }
});

app.post(
  "/api/organizations/:organizationId/cloudflare/account",
  async (context) => {
    const organizationId = context.req.param("organizationId");
    const { session } = await requireOrganizationMember(
      context,
      organizationId
    );
    const input = cloudflareAccountSchema.parse(
      await readJson<unknown>(context)
    );
    const db = createDb(context.env.DB);
    const rows = await db
      .select({
        id: cloudflareConnection.id,
        accountId: cloudflareConnection.accountId,
        gatewayId: cloudflareConnection.gatewayId,
        accountOptionsJson: cloudflareConnection.accountOptionsJson,
        accessTokenCiphertext: cloudflareConnection.accessTokenCiphertext,
        accessTokenIv: cloudflareConnection.accessTokenIv,
      })
      .from(cloudflareConnection)
      .where(
        and(
          eq(cloudflareConnection.organizationId, organizationId),
          eq(cloudflareConnection.userId, session.user.id)
        )
      )
      .limit(1);
    const connection = rows[0];
    if (!connection)
      throw new HTTPException(404, { message: "Cloudflare is not connected" });
    const accounts = parseCloudflareAccountOptions(
      connection.accountOptionsJson,
    );
    if (
      !accounts.some(
        (account) =>
          account.id === input.accountId && account.name === input.accountName
      )
    ) {
      throw new HTTPException(400, {
        message: "Cloudflare account is not available to this connection",
      });
    }
    let gatewayId: string;
    try {
      const accessToken = await decryptCloudflareToken(
        context.env,
        {
          ciphertext: connection.accessTokenCiphertext,
          iv: connection.accessTokenIv,
        },
        organizationId,
        session.user.id,
        "access",
      );
      gatewayId = await ensureCloudflareGateway(
        accessToken,
        input.accountId,
        session.user.id,
        connection.gatewayId,
      );
    } catch (cause) {
      console.error(
        "Cloudflare Gateway setup failed",
        cause instanceof Error ? cause.message : cause,
      );
      throw new HTTPException(502, {
        message: "Cloudflare did not allow Flary to create the AI Gateway",
      });
    }
    await db
      .update(cloudflareConnection)
      .set({
        accountId: input.accountId,
        accountName: input.accountName,
        gatewayId,
        accountOptionsJson: "[]",
        updatedAt: new Date(),
      })
      .where(eq(cloudflareConnection.id, connection.id));
    return context.json({
      ok: true,
      accountId: input.accountId,
      accountName: input.accountName,
      gatewayId,
    });
  }
);

app.delete(
  "/api/organizations/:organizationId/cloudflare/connection",
  async (context) => {
    const organizationId = context.req.param("organizationId");
    const { session } = await requireOrganizationMember(
      context,
      organizationId,
    );
    const db = createDb(context.env.DB);
    const rows = await db
      .select()
      .from(cloudflareConnection)
      .where(
        and(
          eq(cloudflareConnection.organizationId, organizationId),
          eq(cloudflareConnection.userId, session.user.id),
        ),
      )
      .limit(1);
    const connection = rows[0];
    if (connection) {
      try {
        const token =
          connection.refreshTokenCiphertext && connection.refreshTokenIv
            ? await decryptCloudflareToken(
                context.env,
                {
                  ciphertext: connection.refreshTokenCiphertext,
                  iv: connection.refreshTokenIv,
                },
                organizationId,
                session.user.id,
                "refresh",
              )
            : await decryptCloudflareToken(
                context.env,
                {
                  ciphertext: connection.accessTokenCiphertext,
                  iv: connection.accessTokenIv,
                },
                organizationId,
                session.user.id,
                "access",
              );
        await revokeCloudflareToken(context.env, token);
      } catch (cause) {
        console.warn(
          "Cloudflare token revocation failed during disconnect",
          cause instanceof Error ? cause.message : cause,
        );
      }
      await db
        .delete(cloudflareConnection)
        .where(eq(cloudflareConnection.id, connection.id));
    }
    return context.json({ ok: true });
  },
);

app.all("/api/organizations/:organizationId/events", async (context) => {
  const organizationId = context.req.param("organizationId");
  await requireOrganizationMember(context, organizationId);
  const id = context.env.ORG_COORDINATOR.idFromName(organizationId);
  const stub = context.env.ORG_COORDINATOR.get(id);
  const target = new URL(`/orgs/${organizationId}/events`, context.req.url);
  return stub.fetch(new Request(target, context.req.raw));
});

app.notFound((context) =>
  context.json(
    {
      error: {
        type: "not_found",
        message: "Runtime route not found",
      },
    },
    404,
  ),
);

app.onError((error, context) => {
  if (error instanceof HTTPException) return error.getResponse();
  if (error instanceof CloudProviderOAuthError) {
    const status =
      error.code === "oauth_session_not_found"
        ? 404
        : error.code === "oauth_connection_forbidden"
          ? 403
          : error.code === "oauth_not_configured"
            ? 503
            : error.code === "oauth_provider_failed"
              ? 502
              : 409;
    return context.json(
      { error: { type: error.code, message: error.message } },
      status,
    );
  }
  console.error("Flary Cloud request failed", error);
  return context.json({ error: "Internal server error" }, 500);
});

export default app;
