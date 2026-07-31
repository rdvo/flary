import { Hono } from "hono";
import { ZodError } from "zod";

import {
  ProviderCredentialLifecycleSchema,
  ProviderEncryptedCredentialHandoffSchema,
  ProviderOAuthCompleteInputSchema,
  ProviderOAuthStartInputSchema,
  ProviderOAuthSessionSchema,
} from "../contracts/connections.js";
import {
  ThreadConnectionsRequestSchema,
  ThreadCompactRequestSchema,
  ThreadCreateRequestSchema,
  ThreadForkRequestSchema,
  ThreadGoalRequestSchema,
  ThreadHistoryDiffRequestSchema,
  ThreadHistoryDiffResponseSchema,
  ThreadHistoryListRequestSchema,
  ThreadHistoryListResponseSchema,
  ThreadMessageRequestSchema,
  ThreadModelSetRequestSchema,
  ThreadModeRequestSchema,
  ThreadPinRequestSchema,
  ThreadReadRequestSchema,
  ThreadRecordListRequestSchema,
  ThreadRenameRequestSchema,
  ThreadRollbackRequestSchema,
  ThreadRestoreRequestSchema,
} from "../contracts/threads.js";
import { ThreadOperationalStateSchema } from "../contracts/runtime.js";
import { ApprovalDecisionSchema } from "../contracts/approvals.js";
import {
  UserInputAnswerRequestSchema,
  UserInputRecordSchema,
} from "../contracts/user-input.js";
import {
  RecallDocumentSchema,
  RecallSearchResponseSchema,
} from "../contracts/recall.js";
import { FlaryHostError, featureUnavailable } from "./errors.js";
import {
  FlaryHostAuthorizationSchema,
  FlaryRecallOpenRequestSchema,
  FlaryRecallSearchRequestSchema,
  FlaryThreadAdmissionSchema,
  type FlaryThreadHostService,
  type FlaryProviderOAuthHostService,
  type FlaryThreadScope,
  type FlaryThreadTarget,
  type ResolveFlaryHostAuthorization,
} from "./types.js";

export interface CreateFlaryHostRouterOptions<TBindings extends object> {
  readonly authorize: ResolveFlaryHostAuthorization<TBindings>;
  readonly service:
    | FlaryThreadHostService
    | ((env: TBindings) => FlaryThreadHostService);
  readonly providerOAuth?:
    | FlaryProviderOAuthHostService
    | ((env: TBindings) => FlaryProviderOAuthHostService);
}

/**
 * Create an auth-neutral Flary thread API.
 *
 * Mount this router at `/api` to use the default `FlaryThreadClient` paths.
 * The host application keeps control of authentication and persistence.
 */
export function createFlaryHostRouter<TBindings extends object>(
  options: CreateFlaryHostRouterOptions<TBindings>,
): Hono<{ Bindings: TBindings }> {
  const router = new Hono<{ Bindings: TBindings }>();

  const serviceFor = (env: TBindings): FlaryThreadHostService =>
    typeof options.service === "function"
      ? options.service(env)
      : options.service;

  const providerOAuthFor = (
    env: TBindings,
  ): FlaryProviderOAuthHostService => {
    if (!options.providerOAuth) {
      throw featureUnavailable("Provider OAuth");
    }
    return typeof options.providerOAuth === "function"
      ? options.providerOAuth(env)
      : options.providerOAuth;
  };

  const scopeFor = async (
    request: Request,
    env: TBindings,
    appId: string,
  ): Promise<FlaryThreadScope> => {
    const authorization = FlaryHostAuthorizationSchema.parse(
      await options.authorize({ request, env, appId }),
    );
    return { authorization, appId };
  };

  const targetFor = async (
    request: Request,
    env: TBindings,
    appId: string,
    threadId: string,
  ): Promise<FlaryThreadTarget> => ({
    ...(await scopeFor(request, env, appId)),
    threadId,
  });

  router.onError((error, context) => {
    if (error instanceof FlaryHostError) {
      return context.json(
        {
          error: {
            type: error.code,
            message: error.message,
            ...(error.details === undefined
              ? {}
              : { details: error.details }),
          },
        },
        error.status as 400,
      );
    }
    if (error instanceof ZodError) {
      return context.json(
        {
          error: {
            type: "invalid_request",
            message: "The Flary request is invalid",
            details: error.issues,
          },
        },
        400,
      );
    }
    throw error;
  });

  router.post("/apps/:appId/provider-oauth/start", async (context) => {
    const scope = await scopeFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
    );
    const input = ProviderOAuthStartInputSchema.parse(
      await context.req.json(),
    );
    return context.json(
      {
        oauth: ProviderOAuthSessionSchema.parse(
          await providerOAuthFor(context.env).start(scope, input),
        ),
      },
      201,
    );
  });

  router.get("/apps/:appId/provider-oauth/:sessionId", async (context) => {
    const scope = await scopeFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
    );
    return context.json({
      oauth: ProviderOAuthSessionSchema.parse(
        await providerOAuthFor(context.env).inspect(
          scope,
          context.req.param("sessionId"),
          { poll: context.req.query("poll") === "true" },
        ),
      ),
    });
  });

  router.post(
    "/apps/:appId/provider-oauth/:sessionId/complete",
    async (context) => {
      const scope = await scopeFor(
        context.req.raw,
        context.env,
        context.req.param("appId"),
      );
      const input = ProviderOAuthCompleteInputSchema.parse(
        await context.req.json(),
      );
      return context.json({
        oauth: ProviderOAuthSessionSchema.parse(
          await providerOAuthFor(context.env).complete(
            scope,
            context.req.param("sessionId"),
            input,
          ),
        ),
      });
    },
  );

  router.get("/apps/:appId/threads/:threadId/user-input", async (context) => {
    const target = await targetFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
      context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.listUserInput) throw featureUnavailable("User input");
    return context.json({
      requests: (await service.listUserInput(target)).map(
        (record) => UserInputRecordSchema.parse(record),
      ),
    });
  });

  router.post(
    "/apps/:appId/threads/:threadId/user-input/:requestId",
    async (context) => {
      const target = await targetFor(
        context.req.raw,
        context.env,
        context.req.param("appId"),
        context.req.param("threadId"),
      );
      const response = UserInputAnswerRequestSchema.parse(
        await context.req.json(),
      );
      const service = serviceFor(context.env);
      if (!service.respondToUserInput) throw featureUnavailable("User input");
      return context.json(
        await service.respondToUserInput(
          target,
          context.req.param("requestId"),
          response,
        ),
      );
    },
  );

  router.post(
    "/apps/:appId/provider-oauth/:sessionId/cancel",
    async (context) => {
      const scope = await scopeFor(
        context.req.raw,
        context.env,
        context.req.param("appId"),
      );
      return context.json({
        oauth: ProviderOAuthSessionSchema.parse(
          await providerOAuthFor(context.env).cancel(
            scope,
            context.req.param("sessionId"),
          ),
        ),
      });
    },
  );

  router.post(
    "/apps/:appId/provider-oauth/handoff",
    async (context) => {
      const scope = await scopeFor(
        context.req.raw,
        context.env,
        context.req.param("appId"),
      );
      const input = ProviderEncryptedCredentialHandoffSchema.parse(
        await context.req.json(),
      );
      if (
        input.grant === "user" &&
        input.ownerUserId !== scope.authorization.actor.id
      ) {
        throw new FlaryHostError(
          403,
          "forbidden",
          "A user credential must be owned by the authenticated actor",
        );
      }
      return context.json(
        {
          credential: ProviderCredentialLifecycleSchema.parse(
            await providerOAuthFor(context.env).importEncrypted(scope, input),
          ),
        },
        201,
      );
    },
  );

  router.post(
    "/apps/:appId/provider-oauth/connections/:connectionId/disconnect",
    async (context) => {
      const scope = await scopeFor(
        context.req.raw,
        context.env,
        context.req.param("appId"),
      );
      await providerOAuthFor(context.env).disconnect(
        scope,
        context.req.param("connectionId"),
      );
      return context.json({ ok: true });
    },
  );

  router.get("/apps/:appId/threads", async (context) => {
    const scope = await scopeFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
    );
    return context.json({
      threads: await serviceFor(context.env).list(scope),
    });
  });

  router.post("/apps/:appId/threads", async (context) => {
    const scope = await scopeFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
    );
    const input = ThreadCreateRequestSchema.parse(await context.req.json());
    assertWorkspaceScope(scope, input.workspace);
    const binding = await serviceFor(context.env).create(scope, input);
    return context.json({ binding }, 201);
  });

  router.get("/apps/:appId/threads/:threadId", async (context) => {
    const target = await targetFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
      context.req.param("threadId"),
    );
    return context.json({
      binding: await serviceFor(context.env).inspect(target),
    });
  });

  router.post("/apps/:appId/threads/:threadId/archive", async (context) => {
    const target = await targetFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
      context.req.param("threadId"),
    );
    return context.json({
      ok: true,
      binding: await serviceFor(context.env).archive(target),
    });
  });

  router.post("/apps/:appId/threads/:threadId/unarchive", async (context) => {
    const target = await targetFor(
      context.req.raw, context.env, context.req.param("appId"), context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.unarchive) throw featureUnavailable("Thread unarchive");
    return context.json({ ok: true, binding: await service.unarchive(target) });
  });

  router.post("/apps/:appId/threads/:threadId/rename", async (context) => {
    const target = await targetFor(
      context.req.raw, context.env, context.req.param("appId"), context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.rename) throw featureUnavailable("Thread rename");
    const input = ThreadRenameRequestSchema.parse(await context.req.json());
    return context.json({ ok: true, binding: await service.rename(target, input) });
  });

  router.post("/apps/:appId/threads/:threadId/pin", async (context) => {
    const target = await targetFor(
      context.req.raw, context.env, context.req.param("appId"), context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.pin) throw featureUnavailable("Thread pin");
    const input = ThreadPinRequestSchema.parse(await context.req.json());
    return context.json({ ok: true, binding: await service.pin(target, input) });
  });

  router.post("/apps/:appId/threads/:threadId/read", async (context) => {
    const target = await targetFor(
      context.req.raw, context.env, context.req.param("appId"), context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.markRead) throw featureUnavailable("Thread unread state");
    const input = ThreadReadRequestSchema.parse(await context.req.json());
    return context.json({ ok: true, binding: await service.markRead(target, input) });
  });

  router.delete("/apps/:appId/threads/:threadId", async (context) => {
    const target = await targetFor(
      context.req.raw, context.env, context.req.param("appId"), context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.delete) throw featureUnavailable("Thread deletion");
    await service.delete(target);
    return context.json({ ok: true });
  });

  router.post("/apps/:appId/threads/:threadId/fork", async (context) => {
    const target = await targetFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
      context.req.param("threadId"),
    );
    const input = ThreadForkRequestSchema.parse(await context.req.json());
    const binding = await serviceFor(context.env).fork(target, input);
    return context.json({ binding }, 201);
  });

  router.post("/apps/:appId/threads/:threadId/mode", async (context) => {
    const target = await targetFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
      context.req.param("threadId"),
    );
    const input = ThreadModeRequestSchema.parse(await context.req.json());
    return context.json({
      binding: await serviceFor(context.env).setMode(
        target,
        input.mode,
        input.reason,
      ),
    });
  });

  router.post(
    "/apps/:appId/threads/:threadId/connections",
    async (context) => {
      const target = await targetFor(
        context.req.raw,
        context.env,
        context.req.param("appId"),
        context.req.param("threadId"),
      );
      const input = ThreadConnectionsRequestSchema.parse(
        await context.req.json(),
      );
      return context.json({
        binding: await serviceFor(context.env).setConnections(
          target,
          input.connectionIds,
        ),
      });
    },
  );

  router.get("/apps/:appId/threads/:threadId/model", async (context) => {
    const target = await targetFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
      context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.modelGet) throw featureUnavailable("Thread model selection");
    return context.json({ model: await service.modelGet(target) });
  });

  router.get("/apps/:appId/threads/:threadId/models", async (context) => {
    const target = await targetFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
      context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.modelList) throw featureUnavailable("Thread model catalog");
    return context.json({ models: await service.modelList(target) });
  });

  router.get("/apps/:appId/threads/:threadId/model/history", async (context) => {
    const target = await targetFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
      context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.modelHistory) throw featureUnavailable("Thread model history");
    return context.json({ history: await service.modelHistory(target) });
  });

  router.post("/apps/:appId/threads/:threadId/model", async (context) => {
    const target = await targetFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
      context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.modelSet) throw featureUnavailable("Thread model selection");
    const input = ThreadModelSetRequestSchema.parse(await context.req.json());
    return context.json({ model: await service.modelSet(target, input) });
  });

  router.post("/apps/:appId/threads/:threadId/messages", async (context) => {
    const target = await targetFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
      context.req.param("threadId"),
    );
    const input = ThreadMessageRequestSchema.parse(await context.req.json());
    const admission = FlaryThreadAdmissionSchema.parse(
      await serviceFor(context.env).submit(target, input),
    );
    return context.json(admission, 202);
  });

  router.post("/apps/:appId/threads/:threadId/interrupt", async (context) => {
    const target = await targetFor(
      context.req.raw, context.env, context.req.param("appId"), context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.interrupt) throw featureUnavailable("Thread interruption");
    await service.interrupt(target);
    return context.json({ ok: true }, 202);
  });

  router.post("/apps/:appId/threads/:threadId/compact", async (context) => {
    const target = await targetFor(
      context.req.raw, context.env, context.req.param("appId"), context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.compact) throw featureUnavailable("Thread compaction");
    const input = ThreadCompactRequestSchema.parse(
      await context.req.json().catch(() => ({})),
    );
    return context.json({ result: await service.compact(target, input) }, 202);
  });

  router.post("/apps/:appId/threads/:threadId/rollback", async (context) => {
    const target = await targetFor(
      context.req.raw, context.env, context.req.param("appId"), context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.rollback) throw featureUnavailable("Thread rollback");
    const input = ThreadRollbackRequestSchema.parse(await context.req.json());
    return context.json({ result: await service.rollback(target, input) }, 202);
  });

  router.post("/apps/:appId/threads/:threadId/restore", async (context) => {
    const target = await targetFor(
      context.req.raw, context.env, context.req.param("appId"), context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.restore) throw featureUnavailable("Thread restore");
    const input = ThreadRestoreRequestSchema.parse(await context.req.json());
    return context.json({ result: await service.restore(target, input) }, 202);
  });

  router.post("/apps/:appId/threads/:threadId/goal", async (context) => {
    const target = await targetFor(
      context.req.raw, context.env, context.req.param("appId"), context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.setGoal) throw featureUnavailable("Thread goals");
    const input = ThreadGoalRequestSchema.parse(await context.req.json());
    return context.json({ goal: await service.setGoal(target, input) }, 201);
  });

  router.delete("/apps/:appId/threads/:threadId/goal", async (context) => {
    const target = await targetFor(
      context.req.raw, context.env, context.req.param("appId"), context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.clearGoal) throw featureUnavailable("Thread goals");
    return context.json({ goal: await service.clearGoal(target) });
  });

  router.get("/apps/:appId/threads/:threadId/turns", async (context) => {
    const target = await targetFor(
      context.req.raw, context.env, context.req.param("appId"), context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.turns) throw featureUnavailable("Thread turn reads");
    const input = ThreadRecordListRequestSchema.parse({
      after: context.req.query("after"),
      limit: context.req.query("limit"),
      types: context.req.query("types")?.split(",").filter(Boolean),
    });
    return context.json({ turns: await service.turns(target, input) });
  });

  router.get("/apps/:appId/threads/:threadId/audit", async (context) => {
    const target = await targetFor(
      context.req.raw, context.env, context.req.param("appId"), context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.auditList) throw featureUnavailable("Thread audit");
    const input = ThreadRecordListRequestSchema.parse({
      after: context.req.query("after"),
      limit: context.req.query("limit"),
      types: context.req.query("types")?.split(",").filter(Boolean),
    });
    return context.json({ records: await service.auditList(target, input) });
  });

  router.get("/apps/:appId/threads/:threadId/audit/export", async (context) => {
    const target = await targetFor(
      context.req.raw, context.env, context.req.param("appId"), context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.auditExport) throw featureUnavailable("Thread audit export");
    const result = await service.auditExport(target);
    return new Response(result, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8" },
    });
  });

  router.post("/apps/:appId/threads/:threadId/subagents/:action", async (context) => {
    const target = await targetFor(
      context.req.raw, context.env, context.req.param("appId"), context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.subagentAction) throw featureUnavailable("Durable subagents");
    const action = context.req.param("action");
    if (!["list", "spawn", "send", "wait", "interrupt", "resume", "close"].includes(action)) {
      throw new FlaryHostError(404, "subagent_action_not_found", "The subagent action was not found");
    }
    const input = await context.req.json().catch(() => ({}));
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new FlaryHostError(400, "invalid_request", "The subagent input must be an object");
    }
    return context.json({
      result: await service.subagentAction(
        target,
        action,
        input as Record<string, unknown>,
      ),
    });
  });

  router.get("/apps/:appId/threads/:threadId/approvals", async (context) => {
    const target = await targetFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
      context.req.param("threadId"),
    );
    return context.json({
      approvals: await serviceFor(context.env).listApprovals(target),
    });
  });

  router.post(
    "/apps/:appId/threads/:threadId/approvals/:approvalId",
    async (context) => {
      const target = await targetFor(
        context.req.raw,
        context.env,
        context.req.param("appId"),
        context.req.param("threadId"),
      );
      const decision = ApprovalDecisionSchema.parse({
        ...(await context.req.json()),
        requestId: context.req.param("approvalId"),
      });
      await serviceFor(context.env).decideApproval(target, decision);
      return context.json({ ok: true });
    },
  );

  router.get("/apps/:appId/threads/:threadId/cursor", async (context) => {
    const target = await targetFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
      context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.operationalState) throw featureUnavailable("Cursor state");
    const state = ThreadOperationalStateSchema.parse(
      await service.operationalState(target),
    );
    return context.json({ cursor: state.cursor });
  });

  router.get("/apps/:appId/threads/:threadId/history", async (context) => {
    const target = await targetFor(
      context.req.raw,
      context.env,
      context.req.param("appId"),
      context.req.param("threadId"),
    );
    const service = serviceFor(context.env);
    if (!service.history) throw featureUnavailable("History");
    const input = ThreadHistoryListRequestSchema.parse({
      limit: context.req.query("limit"),
    });
    return context.json(
      ThreadHistoryListResponseSchema.parse(
        await service.history(target, input.limit ?? 30),
      ),
    );
  });

  router.post(
    "/apps/:appId/threads/:threadId/history/diff",
    async (context) => {
      const target = await targetFor(
        context.req.raw,
        context.env,
        context.req.param("appId"),
        context.req.param("threadId"),
      );
      const service = serviceFor(context.env);
      if (!service.historyDiff) throw featureUnavailable("History diff");
      const input = ThreadHistoryDiffRequestSchema.parse(
        await context.req.json(),
      );
      return context.json(
        ThreadHistoryDiffResponseSchema.parse(
          await service.historyDiff(target, input),
        ),
      );
    },
  );

  router.get(
    "/apps/:appId/threads/:threadId/recall/search",
    async (context) => {
      const target = await targetFor(
        context.req.raw,
        context.env,
        context.req.param("appId"),
        context.req.param("threadId"),
      );
      const service = serviceFor(context.env);
      if (!service.recallSearch) throw featureUnavailable("Recall search");
      const input = FlaryRecallSearchRequestSchema.parse({
        query: context.req.query("query"),
        mode: context.req.query("mode") ?? undefined,
        kinds: context.req
          .query("kinds")
          ?.split(",")
          .filter(Boolean),
        limit: context.req.query("limit") ?? undefined,
      });
      return context.json(
        RecallSearchResponseSchema.parse(
          await service.recallSearch(target, input),
        ),
      );
    },
  );

  router.post(
    "/apps/:appId/threads/:threadId/recall/open",
    async (context) => {
      const target = await targetFor(
        context.req.raw,
        context.env,
        context.req.param("appId"),
        context.req.param("threadId"),
      );
      const service = serviceFor(context.env);
      if (!service.recallOpen) throw featureUnavailable("Recall open");
      const input = FlaryRecallOpenRequestSchema.parse(
        await context.req.json(),
      );
      const document = await service.recallOpen(target, input);
      if (!document) {
        throw new FlaryHostError(
          404,
          "recall_not_found",
          "Recall document not found",
        );
      }
      return context.json({ document: RecallDocumentSchema.parse(document) });
    },
  );

  router.post(
    "/apps/:appId/threads/:threadId/schedules/:action",
    async (context) => {
      const target = await targetFor(
        context.req.raw,
        context.env,
        context.req.param("appId"),
        context.req.param("threadId"),
      );
      const service = serviceFor(context.env);
      if (!service.scheduleAction) {
        throw featureUnavailable("Durable schedules");
      }
      const result = await service.scheduleAction(
        target,
        context.req.param("action"),
        await context.req.json().catch(() => ({})),
      );
      return context.json({ result });
    },
  );

  return router;
}

function assertWorkspaceScope(
  scope: FlaryThreadScope,
  workspace: { organizationId: string; appId: string },
): void {
  if (
    workspace.organizationId !== scope.authorization.organizationId ||
    workspace.appId !== scope.appId
  ) {
    throw new FlaryHostError(
      403,
      "workspace_scope_denied",
      "The workspace does not belong to the authorized application",
    );
  }
}
