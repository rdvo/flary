import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z, ZodError } from "zod";

import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  CancelRunRequestSchema,
  CreateRunRequestSchema,
  RunEventSchema,
  RunHandleSchema,
  RunInputSchema,
  RunResultSchema,
  UserInputAnswerRequestSchema,
  UserInputRecordSchema,
  type ApprovalDecision,
  type ApprovalRequest,
  type CancelRunRequest,
  type CreateRunRequest,
  type RunEvent,
  type RunHandle,
  type RunInput,
  type RunResult,
  type UserInputAnswerRequest,
  type UserInputRecord,
} from "../contracts/index.js";
import {
  IdentityReferenceSchema,
  type IdentityReference,
} from "../contracts/identity.js";
import {
  IdentifierSchema,
  MetadataSchema,
} from "../contracts/common.js";
import { FlaryHostError, featureUnavailable } from "./errors.js";

const ApprovalAnswerRequestSchema = ApprovalDecisionSchema.pick({
  status: true,
  comment: true,
  metadata: true,
});

export const TrustedRunContextSchema = z
  .object({
    tenantId: IdentifierSchema,
    applicationId: IdentifierSchema,
    projectId: IdentifierSchema.optional(),
    agentId: IdentifierSchema,
    revisionId: IdentifierSchema.optional(),
    identity: IdentityReferenceSchema,
    roles: z.array(IdentifierSchema).max(128).default([]),
    scopes: z.array(IdentifierSchema).max(256).default([]),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type TrustedRunContext = z.infer<typeof TrustedRunContextSchema>;

export interface ResolveTrustedRunContextInput<TBindings> {
  readonly request: Request;
  readonly env: TBindings;
  readonly runId?: string;
}

export type ResolveTrustedRunContext<TBindings> = (
  input: ResolveTrustedRunContextInput<TBindings>,
) => Promise<TrustedRunContext> | TrustedRunContext;

export interface ObserveRunOptions {
  readonly afterSequence: number;
  readonly signal: AbortSignal;
}

/**
 * Durable execution boundary used by the open-source run router.
 *
 * Implementations can use Flue, a Workflow, or another durable engine. They
 * must persist trusted context during `create` and verify it on later calls.
 */
export interface FlaryRunService {
  create(
    context: TrustedRunContext,
    request: CreateRunRequest,
  ): Promise<RunHandle>;
  get(context: TrustedRunContext, runId: string): Promise<RunResult>;
  observe(
    context: TrustedRunContext,
    runId: string,
    options: ObserveRunOptions,
  ): AsyncIterable<RunEvent>;
  input(
    context: TrustedRunContext,
    runId: string,
    input: RunInput,
  ): Promise<RunResult>;
  cancel(
    context: TrustedRunContext,
    runId: string,
    input: CancelRunRequest,
  ): Promise<RunResult>;
  /** List approval requests after the service validates durable run ownership. */
  listApprovals?(
    context: TrustedRunContext,
    runId: string,
  ): Promise<ApprovalRequest[]>;
  /** Persist one approval decision and wake the owning durable execution. */
  decideApproval?(
    context: TrustedRunContext,
    runId: string,
    decision: ApprovalDecision,
  ): Promise<RunResult>;
  /** List user-input requests after the service validates durable ownership. */
  listUserInput?(
    context: TrustedRunContext,
    runId: string,
  ): Promise<UserInputRecord[]>;
  /** Persist user input and wake the owning durable execution. */
  respondToUserInput?(
    context: TrustedRunContext,
    runId: string,
    requestId: string,
    input: UserInputAnswerRequest,
  ): Promise<RunResult>;
}

export interface CreateFlaryRunRouterOptions<TBindings extends object> {
  readonly resolveContext: ResolveTrustedRunContext<TBindings>;
  readonly service:
    | FlaryRunService
    | ((
        env: TBindings,
        execution: { waitUntil(work: Promise<unknown>): void },
      ) => FlaryRunService);
  readonly heartbeatMs?: number;
}

/**
 * Create the stable Flary run API.
 *
 * Mount this router below an application route such as
 * `/v1/agents/:agentId`. The public request never supplies tenant or identity
 * fields. The host resolves those values after its own authentication.
 */
export function createFlaryRunRouter<TBindings extends object>(
  options: CreateFlaryRunRouterOptions<TBindings>,
): Hono<{ Bindings: TBindings }> {
  const router = new Hono<{ Bindings: TBindings }>();
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const serviceFor = (
    env: TBindings,
    execution: { waitUntil(work: Promise<unknown>): void },
  ): FlaryRunService =>
    typeof options.service === "function"
      ? options.service(env, execution)
      : options.service;
  const executionFor = (context: {
    readonly executionCtx: {
      waitUntil(work: Promise<unknown>): void;
    };
  }): { waitUntil(work: Promise<unknown>): void } => {
    try {
      return context.executionCtx;
    } catch {
      // Hono's direct `app.request()` test helper has no Worker
      // ExecutionContext. A host callback can still run synchronously.
      return { waitUntil: () => undefined };
    }
  };
  const contextFor = async (
    request: Request,
    env: TBindings,
    runId?: string,
  ): Promise<TrustedRunContext> =>
    TrustedRunContextSchema.parse(
      await options.resolveContext({ request, env, runId }),
    );

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
            message: "The Flary run request is invalid",
            details: error.issues,
          },
        },
        400,
      );
    }
    throw error;
  });

  router.post("/runs", async (context) => {
    const trusted = await contextFor(context.req.raw, context.env);
    const request = CreateRunRequestSchema.parse(await context.req.json());
    const handle = RunHandleSchema.parse(
      await serviceFor(context.env, executionFor(context)).create(
        trusted,
        request,
      ),
    );
    return context.json(handle, 202);
  });

  router.get("/runs/:runId", async (context) => {
    const runId = IdentifierSchema.parse(context.req.param("runId"));
    const trusted = await contextFor(context.req.raw, context.env, runId);
    return context.json(
      RunResultSchema.parse(
        await serviceFor(context.env, executionFor(context)).get(
          trusted,
          runId,
        ),
      ),
    );
  });

  router.get("/runs/:runId/events", async (context) => {
    const runId = IdentifierSchema.parse(context.req.param("runId"));
    const trusted = await contextFor(context.req.raw, context.env, runId);
    const headerCursor = context.req.header("Last-Event-ID");
    const queryCursor = context.req.query("afterSequence");
    const afterSequence = parseSequence(queryCursor ?? headerCursor);
    const events = serviceFor(context.env, executionFor(context)).observe(
      trusted,
      runId,
      {
      afterSequence,
      signal: context.req.raw.signal,
      },
    );

    return streamSSE(context, async (stream) => {
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "heartbeat", data: "{}" });
      }, heartbeatMs);
      try {
        for await (const eventInput of events) {
          const event = RunEventSchema.parse(eventInput);
          await stream.writeSSE({
            id: String(event.sequence),
            event: event.type,
            data: JSON.stringify(event),
          });
        }
      } finally {
        clearInterval(heartbeat);
      }
    });
  });

  router.post("/runs/:runId/input", async (context) => {
    const runId = IdentifierSchema.parse(context.req.param("runId"));
    const trusted = await contextFor(context.req.raw, context.env, runId);
    const input = RunInputSchema.parse(await context.req.json());
    return context.json(
      RunResultSchema.parse(
        await serviceFor(context.env, executionFor(context)).input(
          trusted,
          runId,
          input,
        ),
      ),
      202,
    );
  });

  router.post("/runs/:runId/cancel", async (context) => {
    const runId = IdentifierSchema.parse(context.req.param("runId"));
    const trusted = await contextFor(context.req.raw, context.env, runId);
    const input = CancelRunRequestSchema.parse(await context.req.json());
    return context.json(
      RunResultSchema.parse(
        await serviceFor(context.env, executionFor(context)).cancel(
          trusted,
          runId,
          input,
        ),
      ),
      202,
    );
  });

  router.get("/runs/:runId/approvals", async (context) => {
    const runId = IdentifierSchema.parse(context.req.param("runId"));
    const trusted = await contextFor(context.req.raw, context.env, runId);
    const service = serviceFor(context.env, executionFor(context));
    if (!service.listApprovals) throw featureUnavailable("Run approvals");
    return context.json({
      approvals: (await service.listApprovals(trusted, runId)).map((value) =>
        ApprovalRequestSchema.parse(value),
      ),
    });
  });

  router.post(
    "/runs/:runId/approvals/:approvalId",
    async (context) => {
      const runId = IdentifierSchema.parse(context.req.param("runId"));
      const approvalId = IdentifierSchema.parse(
        context.req.param("approvalId"),
      );
      const trusted = await contextFor(context.req.raw, context.env, runId);
      const input = ApprovalAnswerRequestSchema.parse(
        await context.req.json(),
      );
      const service = serviceFor(context.env, executionFor(context));
      if (!service.decideApproval) throw featureUnavailable("Run approvals");
      const decision = ApprovalDecisionSchema.parse({
        requestId: approvalId,
        status: input.status,
        decidedBy: trusted.identity,
        decidedAt: new Date().toISOString(),
        ...(input.comment ? { comment: input.comment } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
      return context.json(
        RunResultSchema.parse(
          await service.decideApproval(trusted, runId, decision),
        ),
        202,
      );
    },
  );

  router.get("/runs/:runId/user-input", async (context) => {
    const runId = IdentifierSchema.parse(context.req.param("runId"));
    const trusted = await contextFor(context.req.raw, context.env, runId);
    const service = serviceFor(context.env, executionFor(context));
    if (!service.listUserInput) throw featureUnavailable("Run user input");
    return context.json({
      requests: (await service.listUserInput(trusted, runId)).map((value) =>
        UserInputRecordSchema.parse(value),
      ),
    });
  });

  router.post(
    "/runs/:runId/user-input/:requestId",
    async (context) => {
      const runId = IdentifierSchema.parse(context.req.param("runId"));
      const requestId = IdentifierSchema.parse(context.req.param("requestId"));
      const trusted = await contextFor(context.req.raw, context.env, runId);
      const input = UserInputAnswerRequestSchema.parse(
        await context.req.json(),
      );
      const service = serviceFor(context.env, executionFor(context));
      if (!service.respondToUserInput) {
        throw featureUnavailable("Run user input");
      }
      return context.json(
        RunResultSchema.parse(
          await service.respondToUserInput(
            trusted,
            runId,
            requestId,
            input,
          ),
        ),
        202,
      );
    },
  );

  return router;
}

function parseSequence(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new FlaryHostError(
      400,
      "invalid_stream_cursor",
      "The event cursor must be a non-negative safe integer",
    );
  }
  return sequence;
}

export type {
  CancelRunRequest,
  CreateRunRequest,
  IdentityReference,
  RunEvent,
  RunHandle,
  RunInput,
  RunResult,
};
