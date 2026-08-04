import {
  ApprovalDecisionSchema,
  ThreadBindingSchema,
  ThreadCreateRequestSchema,
  ThreadForkRequestSchema,
  ThreadEditRequestSchema,
  ThreadHistoryRestoreRequestSchema,
  ThreadMessageRequestSchema,
  ThreadModelSetRequestSchema,
  UserInputAnswerRequestSchema,
  type ApprovalDecision,
  type ThreadBinding,
  type ThreadCreateRequest,
  type ThreadForkRequest,
  type ThreadMessageRequest,
  type ThreadModelSetRequest,
  type ThreadPortableArchive,
} from "../contracts/index.js";
import {
  RealtimeClientFrameSchema,
  RealtimeTicketRequestSchema,
  type RealtimeClientFrame,
  type RealtimeServerFrame,
} from "../contracts/realtime.js";
import {
  ModelSelectionSchema,
  ResolvedModelPinSchema,
  normalizeModelInput,
  type ModelSelection,
  type ResolvedModelPin,
} from "../contracts/provider.js";
import { toFlueModelSpecifier } from "../providers/resolver.js";
import type {
  FlaryThreadHostService,
  FlaryThreadScope,
  FlaryThreadTarget,
} from "../host/types.js";
import { threadName } from "../storage/scopes.js";
import {
  cloudflareWorkspaceObjectName,
  createCloudflareWorkspaceConnection,
} from "./workspace.js";
import { CloudflareSandboxWorkspaceBackend } from "./workspace-execution.js";
import { createCloudflareFlueFetch, createCloudflareFlueGateway } from "./function-host.js";
import { SqliteSubagentCoordinator } from "./subagent-coordinator.js";
import { DurableSandboxProcessRuntime } from "./sandbox-process-runtime.js";
import { SqliteSandboxProcessRegistry } from "./sandbox-process-registry.js";
import {
  D1ThreadCatalog,
  type D1DatabaseLike,
} from "./d1-thread-catalog.js";
import {
  exportSessionJsonl,
  importSessionJsonl,
  FlarySessionProjector,
  SqliteCanonicalSessionArchive,
  R2SessionArchive,
  SqliteSessionLedger,
  type SessionArchiveBucket,
  type SessionRecord,
  type SessionRecordType,
} from "../session/index.js";
import type { FlueAdmission, FlueAgentGateway } from "../flue/service.js";
import { FlaryHostError } from "../host/errors.js";
import {
  assertPublicBrowserUrl,
  browserStateObjectKey,
} from "../functions/browser.js";

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

interface ProjectionQueue {
  send(message: unknown): Promise<void>;
}

interface ProjectionQueueMessage {
  readonly body: unknown;
  ack(): void;
  retry(): void;
}

interface ThreadControlWebSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment?(value: unknown): void;
  deserializeAttachment?(): unknown;
}

interface ThreadControlWebSocketHost {
  acceptWebSocket(socket: ThreadControlWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): ThreadControlWebSocket[];
}

interface ThreadControlStorage {
  sql: {
    exec<T = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): { toArray(): T[] };
    transactionSync<T>(closure: () => T): T;
  };
  /** Durable Object storage owns transactionSync in the Workers runtime. */
  transactionSync?<T>(closure: () => T): T;
  setAlarm?(scheduledTime: number | Date): Promise<void>;
}

/**
 * Adapt real Durable Object storage to the composite SQL shape used here.
 * Cloudflare exposes exec() on storage.sql, but transactionSync() on storage.
 * Local test doubles historically put both methods on storage.sql.
 */
function normalizeThreadControlStorage(
  input: ThreadControlStorage,
): ThreadControlStorage {
  const rawSql = input.sql as {
    exec<T = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): { toArray(): T[] };
    transactionSync?<T>(closure: () => T): T;
  };
  const transactionSync = input.transactionSync ?? rawSql.transactionSync;
  if (typeof transactionSync !== "function") {
    throw new Error(
      "Thread Control needs Durable Object transactionSync support",
    );
  }
  const owner = input.transactionSync ? input : rawSql;
  return {
    sql: {
      exec: rawSql.exec.bind(rawSql),
      transactionSync: transactionSync.bind(owner),
    },
    ...(typeof input.setAlarm === "function"
      ? { setAlarm: input.setAlarm.bind(input) }
      : {}),
  };
}

export interface CreateCloudflareThreadServiceOptions<
  TEnv extends Record<string, unknown>,
> {
  readonly env: TEnv;
  readonly namespace?: DurableObjectNamespace;
  readonly binding?: string;
  /** Resolve an opaque provider grant before a new turn is admitted. */
  readonly resolveModel?: (input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly applicationId: string;
    readonly connectionIds: readonly string[];
    readonly selection: ModelSelection;
  }) => Promise<Partial<ResolvedModelPin> | void> | Partial<ResolvedModelPin> | void;
}

interface ThreadControlExecutionContext {
  waitUntil(work: Promise<unknown>): void;
}

/**
 * Connect the public thread host API to one Thread Control Durable Object.
 *
 * Flue remains the transcript and execution authority. This service stores
 * only tenant ownership, mutable controls, and the rebuildable session view.
 */
export function createCloudflareThreadService<
  TEnv extends Record<string, unknown>,
>(
  options: CreateCloudflareThreadServiceOptions<TEnv>,
): FlaryThreadHostService {
  const namespace =
    options.namespace ??
    (options.env[options.binding ?? "FLARY_THREAD_CONTROL"] as
      | DurableObjectNamespace
      | undefined);
  if (!namespace) {
    throw new Error("FLARY_THREAD_CONTROL is not configured");
  }
  const gateway = createCloudflareFlueGateway(options.env, {
    token:
      typeof options.env.FLARY_INTERNAL_TOKEN === "string"
        ? options.env.FLARY_INTERNAL_TOKEN
        : undefined,
  });

  const rpc = async (
    name: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<any> => {
    const stub = namespace.get(namespace.idFromName(name));
    const response = await stub.fetch(
      new Request(`https://flary.internal/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, ...body }),
      }),
    );
    const value = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(
        value && typeof value === "object" && "error" in value
          ? String((value as { error: unknown }).error)
          : `Thread Control failed (${response.status})`,
      );
    }
    return value;
  };
  const controlName = (target: FlaryThreadTarget) =>
    `thread:${target.authorization.organizationId}:${target.appId}:${target.threadId}`;
  const catalogName = (scope: FlaryThreadScope) =>
    `catalog:${scope.authorization.organizationId}:${scope.appId}`;
  const ownership = (scope: FlaryThreadScope) => ({
    tenantId: scope.authorization.organizationId,
    applicationId: scope.appId,
  });
  const d1 = options.env.FLARY_THREAD_CATALOG
    ? new D1ThreadCatalog(
        options.env.FLARY_THREAD_CATALOG as D1DatabaseLike,
      )
    : undefined;
  const projectionQueue = options.env.FLARY_SESSION_PROJECTION_QUEUE as
    | ProjectionQueue
    | undefined;
  const trackAdmission = async (
    name: string,
    body: Record<string, unknown>,
  ): Promise<void> => {
    if (projectionQueue) {
      await projectionQueue.send({ controlName: name, ...body });
      return;
    }
    await rpc(name, "track", body);
  };

  const service: FlaryThreadHostService = {
    async list(scope) {
      if (d1) {
        return d1.list({
          tenantId: scope.authorization.organizationId,
          applicationId: scope.appId,
          agentId: scope.appId,
        });
      }
      const value = await rpc(catalogName(scope), "list", ownership(scope));
      return ThreadBindingSchema.array().parse(value.bindings ?? []);
    },
    async create(scope, rawInput) {
      const input = ThreadCreateRequestSchema.parse(rawInput);
      const now = new Date().toISOString();
      const threadId =
        input.threadId ?? `thread_${crypto.randomUUID().replaceAll("-", "")}`;
      const binding = ThreadBindingSchema.parse({
        thread: {
          organizationId: scope.authorization.organizationId,
          appId: scope.appId,
          agentId: input.agentId,
          threadId,
        },
        workspace: input.workspace,
        agentId: input.agentId,
        persona: input.persona,
        defaultMode: input.mode,
        defaultModel: input.model,
        defaultThinkingLevel: input.thinkingLevel,
        connectionIds: input.connectionIds,
        createdBy: scope.authorization.actor,
        status: "active",
        createdAt: now,
        updatedAt: now,
        metadata: input.metadata,
      });
      await rpc(
        `thread:${scope.authorization.organizationId}:${scope.appId}:${threadId}`,
        "initialize",
        { ...ownership(scope), binding },
      );
      await rpc(catalogName(scope), "catalogPut", {
        ...ownership(scope),
        binding,
      });
      await d1?.put(binding);
      return binding;
    },
    async realtimeTicket(target, rawInput, requestUrl) {
      const input = RealtimeTicketRequestSchema.parse(rawInput);
      await service.inspect(target);
      const ticket = `${target.authorization.organizationId}.${crypto.randomUUID()}.${crypto.randomUUID()}`;
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      await rpc(controlName(target), "issueRealtimeTicket", {
        ...ownership(target),
        ticketHash: await sha256Text(ticket),
        expiresAt,
        after: input.after,
        includeChildren: input.includeChildren,
        actor: target.authorization.actor,
      });
      const url = new URL(requestUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = url.pathname.replace(/\/realtime-ticket$/, "/realtime");
      url.search = new URLSearchParams({ ticket }).toString();
      return { url: url.toString(), expiresAt };
    },
    async realtimeConnect(appId, threadId, ticket) {
      const tenantId = ticket.split(".", 1)[0];
      if (!tenantId) {
        return Response.json({ error: "The realtime ticket is invalid" }, { status: 401 });
      }
      const name = `thread:${tenantId}:${appId}:${threadId}`;
      const stub = namespace.get(namespace.idFromName(name));
      return stub.fetch(new Request(
        `https://flary.internal/realtime?ticket=${encodeURIComponent(ticket)}`,
        { headers: { upgrade: "websocket" } },
      ));
    },
    async inspect(target) {
      const value = await rpc(controlName(target), "inspect", ownership(target));
      return ThreadBindingSchema.parse(value.binding);
    },
    async archive(target) {
      return mutateBinding(target, "archive");
    },
    async unarchive(target) {
      return mutateBinding(target, "unarchive");
    },
    async rename(target, input) {
      return mutateBinding(target, "rename", input);
    },
    async pin(target, input) {
      return mutateBinding(target, "pin", input);
    },
    async markRead(target, input) {
      return mutateBinding(target, "markRead", input);
    },
    async delete(target) {
      const siblings = await service.list({
        authorization: target.authorization,
        appId: target.appId,
      });
      const children = siblings.filter((candidate) =>
        candidate.metadata &&
        typeof candidate.metadata.parentThreadId === "string" &&
        candidate.metadata.parentThreadId === target.threadId,
      );
      for (const child of children) {
        await service.delete?.({
          authorization: target.authorization,
          appId: target.appId,
          threadId: child.thread.threadId,
        });
      }
      await rpc(controlName(target), "delete", ownership(target));
      await rpc(catalogName(target), "catalogDelete", {
        ...ownership(target),
        threadId: target.threadId,
      });
      await d1?.delete({
        tenantId: target.authorization.organizationId,
        applicationId: target.appId,
        threadId: target.threadId,
      });
    },
    async fork(target, rawInput) {
      const input = ThreadForkRequestSchema.parse(rawInput);
      const parent = await service.inspect(target);
      const parentLedger = await rpc(controlName(target), "records", {
        ...ownership(target),
        after: 0,
        limit: 1_000_000,
      });
      const records = Array.isArray(parentLedger.records)
        ? parentLedger.records as Array<Record<string, unknown>>
        : [];
      const boundary = resolveForkBoundary(records, input.turnId);
      let canonicalArchive: unknown;
      if (boundary.turnId) {
        const exported = await agentControlRpc(
          options.env,
          parent,
          "export",
          { turnId: boundary.turnId },
        );
        if (objectValue(exported).runtimeUnavailable) {
          throw new FlaryHostError(
            503,
            "exact_fork_runtime_unavailable",
            "The canonical session engine is not available for an exact fork",
          );
        }
        canonicalArchive = exported;
      }
      const childThreadId = input.threadId ?? `thread_${crypto.randomUUID()}`;
      const childWorkspace = input.workspace === "shared"
        ? parent.workspace
        : {
            ...parent.workspace,
            branch: forkWorkspaceBranch(parent.workspace.branch, childThreadId),
          };
      const child = await service.create(target, {
        threadId: childThreadId,
        agentId: parent.agentId,
        workspace: childWorkspace,
        persona: parent.persona,
        mode: input.mode ?? parent.defaultMode,
        model: input.model ?? parent.defaultModel,
        thinkingLevel:
          input.thinkingLevel ?? parent.defaultThinkingLevel,
        connectionIds: parent.connectionIds,
        metadata: {
          ...(input.metadata ?? {}),
          parentThreadId: target.threadId,
          ...(boundary.turnId ? { forkTurnId: boundary.turnId } : {}),
          forkWorkspaceMode: input.workspace,
        },
      });
      try {
        if (canonicalArchive !== undefined) {
          await agentControlRpc(options.env, child, "import", {
            archive: canonicalArchive,
            turnId: boundary.turnId,
          });
        }
        await rpc(controlName({
          ...target,
          threadId: child.thread.threadId,
        }), "forkRecords", {
          ...ownership(target),
          records: boundary.records,
          parentThreadId: target.threadId,
        });
        if (
          input.workspace === "snapshot" &&
          boundary.checkpointId &&
          options.env.FLARY_WORKSPACE &&
          options.env.WORKSPACE_BLOBS
        ) {
          await workspaceControl(options.env, child, "__fork", {
            sourceScope: parent.workspace,
            commitId: boundary.checkpointId,
            id: `fork_${child.thread.threadId}_${boundary.checkpointId}`.slice(0, 200),
            parentThreadId: target.threadId,
            sessionId: child.thread.threadId,
          });
        }
      } catch (error) {
        await service.delete?.({
          authorization: target.authorization,
          appId: target.appId,
          threadId: child.thread.threadId,
        }).catch(() => undefined);
        throw error;
      }
      return child;
    },
    async setMode(target, mode, reason) {
      return mutateBinding(target, "setMode", { mode, reason });
    },
    async setConnections(target, connectionIds) {
      return mutateBinding(target, "setConnections", { connectionIds });
    },
    async modelGet(target) {
      const value = await rpc(controlName(target), "modelGet", ownership(target));
      return value.model;
    },
    async modelList(target) {
      const value = await rpc(controlName(target), "modelList", ownership(target));
      return Array.isArray(value.models) ? value.models : [];
    },
    async modelSet(target, input) {
      const parsed = ThreadModelSetRequestSchema.parse(input);
      const value = await rpc(controlName(target), "modelSet", {
        ...ownership(target),
        input: parsed,
        actor: target.authorization.actor,
      });
      const updated = await service.inspect(target);
      await rpc(catalogName(target), "catalogPut", {
        ...ownership(target),
        binding: updated,
      });
      await d1?.put(updated);
      return value.model;
    },
    async modelHistory(target) {
      const value = await rpc(controlName(target), "modelHistory", ownership(target));
      return Array.isArray(value.history) ? value.history : [];
    },
    async submit(target, rawInput) {
      const input = ThreadMessageRequestSchema.parse(rawInput);
      const binding = await service.inspect(target);
      const instanceId = threadName(binding.thread);
      const admissionId = input.idempotencyKey ?? crypto.randomUUID();
      const selectedModel = input.model === undefined
        ? undefined
        : normalizeModelInput(input.model);
      const requested = selectedModel
        ? {
            ...selectedModel,
            ...(input.thinkingLevel
              ? { reasoningEffort: input.thinkingLevel }
              : {}),
            ...(input.cacheRetention
              ? { cacheRetention: input.cacheRetention }
              : {}),
          }
        : undefined;
      const configured = requested ?? binding.defaultModel ??
        (await rpc(controlName(target), "modelGet", ownership(target))).model;
      const baseSelection = configured
        ? normalizeModelInput(configured)
        : undefined;
      const selection = baseSelection
        ? {
            ...baseSelection,
            ...(input.thinkingLevel
              ? { reasoningEffort: input.thinkingLevel }
              : {}),
            ...(input.cacheRetention
              ? { cacheRetention: input.cacheRetention }
              : {}),
          }
        : undefined;
      const grant = selection
        ? await options.resolveModel?.({
            tenantId: target.authorization.organizationId,
            userId: target.authorization.actor.id,
            applicationId: target.appId,
            connectionIds: binding.connectionIds,
            selection,
          })
        : undefined;
      const pinnedValue = await rpc(controlName(target), "pinModel", {
        ...ownership(target),
        admissionId,
        ...(selection ? { model: selection } : {}),
        ...(grant ? { grant } : {}),
      });
      const pin = pinnedValue.pin as ResolvedModelPin;
      const segmentId = String(pinnedValue.segmentId ?? `segment_${admissionId}`);
      await rpc(controlName(target), "admitTurn", {
        ...ownership(target),
        admissionId,
      });
      if (input.mode === "steer") {
        // Keep the interrupted turn visible before admitting its replacement.
        // The Flue abort is asynchronous, so the ledger records the durable
        // steer intent first and recovery can rebuild this boundary.
        await rpc(controlName(target), "record", {
          ...ownership(target),
          recordType: "turn.aborted",
          payload: {
            replacementAdmissionId: admissionId,
            reason: "steered",
            recordedAt: new Date().toISOString(),
          },
        });
        await gateway.abort(runtimeAgentId(binding), instanceId).catch(() => undefined);
      }
      const admission = await gateway.send(
        runtimeAgentId(binding),
        instanceId,
        input.message,
        {
          idempotencyKey: admissionId,
          model: toFlueModelSpecifier(ModelSelectionSchema.parse(pin.selection)),
          ...(input.images ? { images: input.images } : {}),
          ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
          ...(input.cacheRetention ? { cacheRetention: input.cacheRetention } : {}),
        },
      );
      await rpc(controlName(target), "record", {
        ...ownership(target),
        recordType: "turn.started",
        payload: {
          admissionId,
          submissionId: admission.submissionId,
          mode: input.mode ?? "queue",
          modelPin: pin,
          segmentId,
        },
      });
      await rpc(controlName(target), "record", {
        ...ownership(target),
        recordType: "turn.settings",
        payload: { modelPin: pin, admissionId },
      });
      await trackAdmission(controlName(target), {
        ...ownership(target),
        admission,
        admissionId,
        agentId: binding.agentId,
        instanceId,
        modelPin: pin,
        segmentId,
        turnMessage: input.message,
      });
      return admission;
    },
    async edit(target, rawInput) {
      const input = ThreadEditRequestSchema.parse(rawInput);
      const editId = input.idempotencyKey ?? `edit_${crypto.randomUUID()}`;
      const binding = await service.inspect(target);
      const rollback = {
        turnId: input.turnId,
        reason: "message replacement",
        excludeTarget: true,
      };
      const rollbackResult = await agentControlRpc(
        options.env,
        binding,
        "rollback",
        rollback,
      );
      await projectAgentSnapshot(options.env, binding, (event, sourceCursor) =>
        rpc(controlName(target), "project", {
          ...ownership(target),
          event,
          sourceCursor,
        })
      );
      await rpc(controlName(target), "record", {
        ...ownership(target),
        recordType: "rollback",
        payload: {
          ...rollback,
          applied: !objectValue(rollbackResult).runtimeUnavailable,
        },
      });
      const admission = await service.submit(target, {
        message: input.message,
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.images ? { images: input.images } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.thinkingLevel
          ? { thinkingLevel: input.thinkingLevel }
          : {}),
        cacheRetention: input.cacheRetention,
        idempotencyKey: editId,
      });
      await rpc(controlName(target), "record", {
        ...ownership(target),
        recordType: "message.edited",
        payload: {
          replacedTurnId: input.turnId,
          replacementSubmissionId: admission.submissionId,
          editId,
        },
      });
      return admission;
    },
    async interrupt(target) {
      const binding = await service.inspect(target);
      await gateway.abort(runtimeAgentId(binding), threadName(binding.thread));
    },
    async compact(target, input) {
      const binding = await service.inspect(target);
      const result = await agentControlRpc(
        options.env,
        binding,
        "compact",
        input,
      );
      await projectAgentSnapshot(options.env, binding, (event, sourceCursor) =>
        rpc(controlName(target), "project", {
          ...ownership(target),
          event,
          sourceCursor,
        })
      );
      await rpc(controlName(target), "record", {
        ...ownership(target),
        recordType: "compaction.started",
        payload: {
          ...input,
          requested: true,
          applied: !objectValue(result).runtimeUnavailable,
        },
      });
      return result;
    },
    async rollback(target, input) {
      const binding = await service.inspect(target);
      const result = await agentControlRpc(
        options.env,
        binding,
        "rollback",
        input,
      );
      await projectAgentSnapshot(options.env, binding, (event, sourceCursor) =>
        rpc(controlName(target), "project", {
          ...ownership(target),
          event,
          sourceCursor,
        })
      );
      await rpc(controlName(target), "record", {
        ...ownership(target),
        recordType: "rollback",
        payload: {
          ...input,
          applied: !objectValue(result).runtimeUnavailable,
        },
      });
      return result;
    },
    async restore(target, input) {
      const binding = await service.inspect(target);
      if (input.archive) {
        const archive = input.archive;
        if (
          archive.source.tenantId !== target.authorization.organizationId ||
          archive.source.applicationId !== target.appId
        ) {
          throw new FlaryHostError(
            404,
            "archive_not_found",
            "The session archive was not found",
          );
        }
        if (archive.sha256 !== await portableArchiveHash(archive)) {
          throw new FlaryHostError(
            400,
            "archive_hash_mismatch",
            "The session archive hash does not match its content",
          );
        }
        const imported = await agentControlRpc(options.env, binding, "import", {
          archive: archive.canonical,
        });
        if (objectValue(imported).runtimeUnavailable) {
          throw new FlaryHostError(
            503,
            "session_engine_unavailable",
            "The canonical session engine is not available for restore",
          );
        }
      }
      return rpc(controlName(target), "restore", {
        ...ownership(target),
        binding,
        input: input.archive
          ? {
              jsonl: input.archive.ledgerJsonl,
              replace: input.replace,
              retarget: input.archive.source.threadId !== target.threadId,
            }
          : input,
      });
    },
    async exportSession(target) {
      const binding = await service.inspect(target);
      const ledger = await rpc(controlName(target), "export", ownership(target));
      const canonical = await agentControlRpc(
        options.env,
        binding,
        "export",
        {},
      );
      if (objectValue(canonical).runtimeUnavailable) {
        throw new FlaryHostError(
          503,
          "session_engine_unavailable",
          "The canonical session engine is not available for export",
        );
      }
      const unsigned = {
        format: "flary-thread-archive" as const,
        version: 1 as const,
        source: {
          tenantId: target.authorization.organizationId,
          applicationId: target.appId,
          threadId: target.threadId,
        },
        exportedAt: new Date().toISOString(),
        ledgerJsonl: String(ledger.jsonl ?? ""),
        canonical,
      };
      return {
        ...unsigned,
        sha256: await sha256Json(unsigned),
      } satisfies ThreadPortableArchive;
    },
    async setGoal(target, input) {
      return rpc(controlName(target), "record", {
        ...ownership(target),
        recordType: "goal.updated",
        payload: input,
      });
    },
    async clearGoal(target) {
      return rpc(controlName(target), "record", {
        ...ownership(target),
        recordType: "goal.cleared",
        payload: {},
      });
    },
    async turns(target, input) {
      const value = await rpc(controlName(target), "records", {
        ...ownership(target),
        ...input,
        families: ["turn.", "message."],
      });
      return value.records ?? [];
    },
    async auditList(target, input) {
      const value = await rpc(controlName(target), "records", {
        ...ownership(target),
        ...input,
      });
      return value.records ?? [];
    },
    async auditExport(target) {
      const value = await rpc(controlName(target), "export", ownership(target));
      return String(value.jsonl ?? "");
    },
    async history(target, limit) {
      const binding = await service.inspect(target);
      return workspaceControl(options.env, binding, "__history", { limit });
    },
    async historyDiff(target, input) {
      const binding = await service.inspect(target);
      return workspaceControl(options.env, binding, "__diff", input);
    },
    async historyRestore(target, rawInput) {
      const input = ThreadHistoryRestoreRequestSchema.parse(rawInput);
      const binding = await service.inspect(target);
      await gateway.abort(
        runtimeAgentId(binding),
        threadName(binding.thread),
      ).catch(() => undefined);
      const result = await workspaceControl(
        options.env,
        binding,
        "__restore",
        input,
      );
      await rpc(controlName(target), "record", {
        ...ownership(target),
        recordType: "artifact.restored",
        payload: { commitId: input.commitId, result },
      });
      return result;
    },
    async subagentAction(target, action, input) {
      let value = await rpc(controlName(target), "subagent", {
        ...ownership(target),
        action,
        input,
      });
      if (action === "spawn" && value.thread) {
        const child = value.thread as {
          threadId: string;
          rootThreadId: string;
          parentThreadId?: string;
          agentId: string;
          task: string;
          model?: ModelSelection;
          reasoningEffort?: string;
          metadata?: Record<string, unknown>;
        };
        const parentBinding = await service.inspect(target);
        const childMetadata = objectValue(child.metadata);
        const childBinding = ThreadBindingSchema.parse({
          ...parentBinding,
          thread: {
            ...parentBinding.thread,
            threadId: child.threadId,
            agentId: child.agentId,
          },
          agentId: child.agentId,
          defaultModel: child.model ?? parentBinding.defaultModel,
          defaultThinkingLevel:
            child.reasoningEffort ?? parentBinding.defaultThinkingLevel,
          parentThread: parentBinding.thread,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {
            ...(parentBinding.metadata ?? {}),
            ...childMetadata,
            parentThreadId: child.parentThreadId ?? target.threadId,
            flarySubagentRootThreadId: child.rootThreadId,
            flarySubagentParentThreadId:
              child.parentThreadId ?? target.threadId,
            subagent: true,
          },
        });
        const childName =
          `thread:${target.authorization.organizationId}:${target.appId}:${child.threadId}`;
        await rpc(childName, "initialize", {
          ...ownership(target),
          binding: childBinding,
        });
        await rpc(catalogName(target), "catalogPut", {
          ...ownership(target),
          binding: childBinding,
        });
        await d1?.put(childBinding);
        try {
          await rpc(controlName(target), "admitTurn", {
            ...ownership(target),
            admissionId: `subagent_${child.threadId}`,
          });
          const admission = await service.submit(
            {
              ...target,
              authorization: {
                ...target.authorization,
                actor: parentBinding.createdBy,
              },
              threadId: child.threadId,
            },
            {
              message: child.task,
              ...(child.model ? { model: child.model } : {}),
              ...(child.reasoningEffort
                ? { thinkingLevel: child.reasoningEffort as never }
                : {}),
              idempotencyKey: `subagent_${child.threadId}`,
            },
          );
          await rpc(controlName(target), "subagent", {
            ...ownership(target),
            action: "start",
            input: {
              threadId: child.threadId,
              admissionId: admission.submissionId,
            },
          });
        } catch (error) {
          await rpc(controlName(target), "subagent", {
            ...ownership(target),
            action: "fail",
            input: {
              threadId: child.threadId,
              error: {
                code: "subagent_admission_failed",
                message: error instanceof Error ? error.message : String(error),
                retryable: true,
              },
            },
          }).catch(() => undefined);
          throw error;
        }
      }
      if (action === "send" && value.message) {
        const message = value.message as {
          toThreadId: string;
          mode: "queue" | "interrupt";
          content: string;
        };
        const child = value.thread as { agentId: string } | undefined;
        if (child) {
          const childName =
            `thread:${target.authorization.organizationId}:${target.appId}:${message.toThreadId}`;
          const childValue = await rpc(childName, "inspect", ownership(target));
          const childBinding = ThreadBindingSchema.parse(childValue.binding);
          const childInstanceId = threadName(childBinding.thread);
          if (message.mode === "interrupt") {
            await gateway
              .abort(runtimeAgentId(childBinding), childInstanceId)
              .catch(() => undefined);
          }
          await service.submit(
            { ...target, threadId: message.toThreadId },
            {
              message: message.content,
              mode: message.mode === "interrupt" ? "steer" : "queue",
              idempotencyKey: `mailbox_${String((value.message as { id?: unknown }).id ?? crypto.randomUUID())}`,
            },
          );
        }
      }
      if (action === "interrupt" && value.thread) {
        const child = value.thread as { threadId: string; agentId: string };
        const childName =
          `thread:${target.authorization.organizationId}:${target.appId}:${child.threadId}`;
        const childValue = await rpc(childName, "inspect", ownership(target));
        const childBinding = ThreadBindingSchema.parse(childValue.binding);
        await gateway
          .abort(runtimeAgentId(childBinding), threadName(childBinding.thread))
          .catch(() => undefined);
      }
      if (action === "wait") {
        const timeoutMs = Math.min(
          Math.max(Number(input.timeoutMs ?? 0), 0),
          30_000,
        );
        const deadline = Date.now() + timeoutMs;
        while (!subagentWaitSettled(value) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          value = await rpc(controlName(target), "subagent", {
            ...ownership(target),
            action,
            input,
          });
        }
        value = {
          ...value,
          timedOut: !subagentWaitSettled(value),
        };
      }
      return value;
    },
    async scheduleAction(target, action, input) {
      return rpc(controlName(target), "schedule", {
        ...ownership(target),
        action,
        input,
      });
    },
    async processAction(target, action, input) {
      return rpc(controlName(target), "process", {
        ...ownership(target),
        action,
        input,
      });
    },
    async browserAction(target, action, input) {
      return rpc(controlName(target), "browser", {
        ...ownership(target),
        action,
        input,
      });
    },
    async listApprovals(target) {
      const value = await agentApprovalRpc(options.env, await service.inspect(target), "approvals");
      return Array.isArray(value.approvals) ? value.approvals : [];
    },
    async decideApproval(target, decisionInput) {
      const decision = ApprovalDecisionSchema.parse(decisionInput);
      await agentApprovalRpc(
        options.env,
        await service.inspect(target),
        "approval",
        decision,
      );
    },
  };

  async function mutateBinding(
    target: FlaryThreadTarget,
    method: string,
    input: unknown = {},
  ): Promise<ThreadBinding> {
    const value = await rpc(controlName(target), method, {
      ...ownership(target),
      input,
    });
    const binding = ThreadBindingSchema.parse(value.binding);
    await rpc(catalogName(target), "catalogPut", {
      ...ownership(target),
      binding,
    });
    await d1?.put(binding);
    return binding;
  }

  return service;
}

/** Request handler used by the generated Thread Control Durable Object. */
export async function handleFlaryThreadControlObjectRequest(input: {
  readonly storage: ThreadControlStorage;
  readonly request: Request;
  readonly env?: Record<string, unknown>;
  readonly execution?: ThreadControlExecutionContext;
  readonly webSockets?: ThreadControlWebSocketHost;
}): Promise<Response> {
  const storage = normalizeThreadControlStorage(input.storage);
  const sql = storage.sql;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS flary_thread_control (
      key TEXT PRIMARY KEY NOT NULL,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS flary_session_projection_dedupe (
      source_cursor TEXT PRIMARY KEY NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS flary_interactive_admissions (
      admission_id TEXT PRIMARY KEY NOT NULL,
      admitted_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS flary_interactive_reservations (
      reservation_id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      reserved_json TEXT NOT NULL,
      actual_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS flary_thread_schedules (
      schedule_id TEXT PRIMARY KEY NOT NULL,
      schedule_json TEXT NOT NULL,
      next_run_at INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS flary_thread_schedules_due
    ON flary_thread_schedules (enabled, next_run_at);
    CREATE TABLE IF NOT EXISTS flary_thread_schedule_runs (
      run_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT NOT NULL,
      scheduled_for INTEGER NOT NULL,
      status TEXT NOT NULL,
      admission_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (schedule_id, scheduled_for)
    );
    CREATE TABLE IF NOT EXISTS flary_realtime_tickets (
      ticket_hash TEXT PRIMARY KEY NOT NULL,
      expires_at TEXT NOT NULL,
      after_sequence INTEGER NOT NULL,
      include_children INTEGER NOT NULL,
      actor_json TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS flary_realtime_commands (
      idempotency_key TEXT PRIMARY KEY NOT NULL,
      request_id TEXT NOT NULL,
      command TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  if (input.request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return openThreadControlWebSocket(storage.sql, input);
  }
  const body = await input.request.json() as Record<string, unknown>;
  const method = String(body.method ?? "");
  try {
    const result = await dispatchThreadControl(sql, method, body, {
      ...input,
      storage,
    });
    await broadcastThreadRecords(sql, input.webSockets).catch(() => undefined);
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Thread Control failed" },
      { status: 400 },
    );
  }
}

async function dispatchThreadControl(
  sql: ThreadControlStorage["sql"],
  method: string,
  body: Record<string, unknown>,
  host?: {
    readonly env?: Record<string, unknown>;
    readonly execution?: ThreadControlExecutionContext;
    readonly storage?: ThreadControlStorage;
    readonly webSockets?: ThreadControlWebSocketHost;
  },
): Promise<unknown> {
  if (method === "issueRealtimeTicket") {
    assertOwner(sql, body);
    const ticketHash = String(body.ticketHash ?? "");
    const expiresAt = String(body.expiresAt ?? "");
    if (!/^[0-9a-f]{64}$/.test(ticketHash) || !Number.isFinite(Date.parse(expiresAt))) {
      throw new Error("The realtime ticket is invalid");
    }
    sql.exec(
      `INSERT INTO flary_realtime_tickets
        (ticket_hash, expires_at, after_sequence, include_children, actor_json, consumed_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      ticketHash,
      expiresAt,
      Math.max(0, Number(body.after ?? 0)),
      body.includeChildren === true ? 1 : 0,
      JSON.stringify(body.actor ?? {}),
    );
    return { issued: true, expiresAt };
  }
  if (method === "realtimeResult") {
    assertOwner(sql, body);
    const idempotencyKey = String(body.idempotencyKey ?? "");
    const requestId = String(body.requestId ?? "");
    const error = body.error && typeof body.error === "object"
      ? body.error as Record<string, unknown>
      : undefined;
    const result = error ? undefined : body.result;
    sql.exec(
      `UPDATE flary_realtime_commands
       SET status = ?, result_json = ?, updated_at = ?
       WHERE idempotency_key = ?`,
      error ? "failed" : "completed",
      JSON.stringify(error ? { error } : { result }),
      new Date().toISOString(),
      idempotencyKey,
    );
    const frame: RealtimeServerFrame = error
      ? {
          version: 1,
          type: "error",
          requestId,
          code: typeof error.code === "string" ? error.code : "command_failed",
          message: typeof error.message === "string" ? error.message : "The realtime command failed",
        }
      : { version: 1, type: "result", requestId, result };
    for (const socket of host?.webSockets?.getWebSockets() ?? []) {
      socket.send(JSON.stringify(frame));
    }
    return { delivered: true };
  }
  if (method === "initialize") {
    const binding = ThreadBindingSchema.parse(body.binding);
    put(sql, "owner", {
      tenantId: body.tenantId,
      applicationId: body.applicationId,
    });
    put(sql, "binding", binding);
    initializeSubagents(sql, binding);
    await appendLedger(sql, binding, "session.manifest", {
      binding,
      status: "active",
    });
    return { binding };
  }
  if (method === "catalogPut") {
    const binding = ThreadBindingSchema.parse(body.binding);
    assertOwner(sql, body, true);
    put(sql, `catalog:${binding.thread.threadId}`, binding);
    return { binding };
  }
  if (method === "list") {
    assertOwner(sql, body, true);
    return {
      bindings: sql.exec<{ value_json: string }>(
        "SELECT value_json FROM flary_thread_control WHERE key LIKE 'catalog:%' ORDER BY key",
      ).toArray().map((row) => JSON.parse(row.value_json)),
    };
  }
  assertOwner(sql, body);
  if (method === "inspect") return { binding: requireBinding(sql) };
  if (method === "catalogDelete") {
    sql.exec("DELETE FROM flary_thread_control WHERE key = ?", `catalog:${String(body.threadId)}`);
    return { ok: true };
  }
  if (method === "delete") {
    const binding = requireBinding(sql);
    await appendLedger(sql, binding, "terminal", { status: "deleted" });
    const bucket = host?.env?.FLARY_SESSION_ARCHIVE as SessionArchiveBucket | undefined;
    const secret = typeof host?.env?.FLARY_SESSION_ARCHIVE_KEY === "string"
      ? host.env.FLARY_SESSION_ARCHIVE_KEY
      : undefined;
    if (bucket && secret) {
      await new R2SessionArchive({ sql, bucket, secret }).deleteSession(
        binding.thread.threadId,
      );
      await new SqliteCanonicalSessionArchive({ sql, bucket, secret }).deleteSession(
        binding.thread.threadId,
      );
    }
    await bucket?.delete?.(browserStateObjectKey({
      organizationId: binding.thread.organizationId,
      appId: binding.thread.appId,
      threadId: binding.thread.threadId,
    }));
    const browserStateRow = sql.exec<{ value_json: string }>(
      "SELECT value_json FROM flary_thread_control WHERE key = 'browser-state'",
    ).toArray()[0];
    const browserState = browserStateRow
      ? objectValue(JSON.parse(browserStateRow.value_json))
      : {};
    if (
      host?.env?.BROWSER &&
      typeof browserState.sessionId === "string"
    ) {
      const playwright = await import("@cloudflare/playwright");
      await playwright.connect(
        host.env.BROWSER as never,
        browserState.sessionId,
      ).then((browser) => browser.close()).catch(() => undefined);
    }
    for (const table of [
      "flary_session_ledger_records",
      "flary_session_ledger_metadata",
      "flary_session_projection_dedupe",
      "flary_interactive_admissions",
      "flary_interactive_reservations",
      "flary_session_archive_segments",
      "flary_canonical_session_archives",
      "flary_realtime_tickets",
      "flary_realtime_commands",
      "flary_thread_schedules",
      "flary_thread_schedule_runs",
      "flary_subagent_config",
      "flary_subagent_sequence",
      "flary_subagent_threads",
      "flary_subagent_turns",
      "flary_subagent_mailbox",
      "flary_subagent_activity",
      "flary_subagent_idempotency",
      "flary_sandbox_processes",
      "flary_sandbox_process_output",
      "flary_sandbox_process_control",
      "flary_sandbox_process_lifecycle",
      "flary_workspace_execution",
      "flary_workspace_execution_state",
      "flary_browser_sessions",
    ]) {
      sql.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    sql.exec("DELETE FROM flary_thread_control");
    return { ok: true };
  }
  if (method === "record") {
    return appendLedger(
      sql,
      requireBinding(sql),
      String(body.recordType ?? "runtime.event") as SessionRecordType,
      objectValue(body.payload),
    );
  }
  if (method === "project") {
    const binding = requireBinding(sql);
    const sourceCursor = String(body.sourceCursor ?? "");
    const seen = sql.exec<{ source_cursor: string }>(
      "SELECT source_cursor FROM flary_session_projection_dedupe WHERE source_cursor = ?",
      sourceCursor,
    ).toArray()[0];
    if (seen) return { projected: false, replay: true };
    const record = await new FlarySessionProjector(
      new SqliteSessionLedger(sql),
      {
        tenantId: binding.thread.organizationId,
        applicationId: binding.thread.appId,
        sessionId: binding.thread.threadId,
        threadId: binding.thread.threadId,
        agentId: binding.agentId,
        sourceRevision:
          typeof binding.metadata?.flaryAgentRevision === "string"
            ? binding.metadata.flaryAgentRevision
            : "flary-thread-control-v1",
      },
    ).project({
      sourceCursor,
      event: objectValue(body.event),
    });
    sql.exec(
      `INSERT OR IGNORE INTO flary_session_projection_dedupe
        (source_cursor, recorded_at) VALUES (?, ?)`,
      sourceCursor,
      new Date().toISOString(),
    );
    return { projected: true, record };
  }
  if (method === "projectChild") {
    assertOwner(sql, body);
    const binding = requireBinding(sql);
    const childThreadId = String(body.childThreadId ?? "");
    const sourceCursor = String(body.sourceCursor ?? "");
    if (!childThreadId || childThreadId === binding.thread.threadId || !sourceCursor) {
      throw new Error("The child projection identity is invalid");
    }
    const seen = sql.exec<{ source_cursor: string }>(
      "SELECT source_cursor FROM flary_session_projection_dedupe WHERE source_cursor = ?",
      sourceCursor,
    ).toArray()[0];
    if (seen) return { projected: false, replay: true };
    const childAgentId = String(body.childAgentId ?? "subagent");
    const producer = safeProducer(body);
    const record = await new SqliteSessionLedger(sql).append({
      tenantId: binding.thread.organizationId,
      applicationId: binding.thread.appId,
      sessionId: binding.thread.threadId,
      threadId: binding.thread.threadId,
      agentId: childAgentId,
      parentId: childThreadId,
      sourceCursor,
      recordType: String(body.recordType ?? "runtime.event") as SessionRecordType,
      recordedAt: String(body.recordedAt ?? new Date().toISOString()),
      attempt: nonnegative(body.attempt, 0),
      sourceRevision: String(body.sourceRevision ?? "flary-child-projection-v1"),
      ...(producer ? { producer } : {}),
      publicPayload: {
        ...objectValue(body.payload),
        _child: { threadId: childThreadId, agentId: childAgentId },
      },
    });
    sql.exec(
      `INSERT OR IGNORE INTO flary_session_projection_dedupe
        (source_cursor, recorded_at) VALUES (?, ?)`,
      sourceCursor,
      new Date().toISOString(),
    );
    return { projected: true, record };
  }
  if (method === "modelGet" || method === "modelList" || method === "modelHistory") {
    const binding = requireBinding(sql);
    if (method === "modelHistory") {
      const value = sql.exec<{ value_json: string }>(
        "SELECT value_json FROM flary_thread_control WHERE key LIKE 'model-history:%' ORDER BY key",
      ).toArray().map((row) => JSON.parse(row.value_json));
      return { history: value };
    }
    const policy = modelPolicy(binding);
    if (method === "modelList") {
      return { models: policy.allow.length > 0 ? policy.allow : (binding.defaultModel ? [binding.defaultModel] : []) };
    }
    const stored = sql.exec<{ value_json: string }>(
      "SELECT value_json FROM flary_thread_control WHERE key = 'model-state'",
    ).toArray()[0];
    return { model: stored ? JSON.parse(stored.value_json) : binding.defaultModel ?? policy.allow[0] };
  }
  if (method === "modelSet") {
    const binding = requireBinding(sql);
    const requested = normalizeModelInput(
      ThreadModelSetRequestSchema.parse(body.input).model,
    );
    const current = currentModel(sql, binding);
    assertAllowedModel(binding, requested);
    const policy = modelPolicy(binding);
    if (policy.switching === "disabled" && current && !sameModel(current, requested)) {
      throw new Error("Model switching is disabled for this agent");
    }
    binding.defaultModel = requested;
    binding.updatedAt = new Date().toISOString();
    put(sql, "binding", ThreadBindingSchema.parse(binding));
    put(sql, "model-state", requested);
    const now = new Date().toISOString();
    const sequence = nextControlSequence(sql, "model-history:");
    const history = {
      sequence,
      model: requested,
      changedAt: now,
      actor: body.actor,
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    };
    put(sql, `model-history:${String(sequence).padStart(12, "0")}`, history);
    await appendLedger(sql, binding, "model.changed", {
      model: requested,
      previousModel: current,
      actor: body.actor,
      sequence,
    });
    if (current && !sameModel(current, requested)) {
      await appendLedger(sql, binding, "provider.cache_reset", {
        from: current,
        to: requested,
        reason: "model_changed",
      });
    }
    return { model: requested, history };
  }
  if (method === "pinModel") {
    const binding = requireBinding(sql);
    const admissionId = String(body.admissionId ?? "");
    if (!admissionId) throw new Error("An admission id is required");
    const existing = sql.exec<{ value_json: string }>(
      "SELECT value_json FROM flary_thread_control WHERE key = ?",
      `model-pin:${admissionId}`,
    ).toArray()[0];
    if (existing) {
      return {
        pin: JSON.parse(existing.value_json),
        segmentId: `segment_${admissionId}`,
        replay: true,
      };
    }
    const requested = body.model
      ? ModelSelectionSchema.parse(body.model)
      : currentModel(sql, binding);
    if (!requested) throw new Error("No model is configured for this agent");
    assertAllowedModel(binding, requested);
    const basePin = resolvedModelPin(binding, requested);
    const grant = body.grant && typeof body.grant === "object" && !Array.isArray(body.grant)
      ? body.grant as Record<string, unknown>
      : {};
    const pin = ResolvedModelPinSchema.parse({
      ...basePin,
      ...(typeof grant.connectionReference === "string"
        ? { connectionReference: grant.connectionReference }
        : {}),
      ...(typeof grant.credentialGeneration === "string"
        ? { credentialGeneration: grant.credentialGeneration }
        : {}),
      ...(grant.billingMode === "managed" || grant.billingMode === "subscription" || grant.billingMode === "byok"
        ? { billingMode: grant.billingMode }
        : {}),
      ...(typeof grant.modelCatalogRevision === "string"
        ? { modelCatalogRevision: grant.modelCatalogRevision }
        : {}),
      ...(typeof grant.adapterRevision === "string"
        ? { adapterRevision: grant.adapterRevision }
        : {}),
    });
    put(sql, `model-pin:${admissionId}`, pin);
    const segmentId = `segment_${admissionId}`;
    const current = currentModel(sql, binding);
    if (current && !sameModel(current, requested)) {
      await appendLedger(sql, binding, "provider.cache_reset", {
        from: current,
        to: requested,
        admissionId,
        reason: "provider_switch",
      });
    }
    await appendLedger(sql, binding, "provider.segment.started", {
      segmentId,
      admissionId,
      pin,
    });
    return { pin, segmentId, replay: false };
  }
  if (method === "forkRecords") {
    const binding = requireBinding(sql);
    const records = Array.isArray(body.records) ? body.records : [];
    let copied = 0;
    for (const value of records) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const source = value as Record<string, unknown>;
      if (source.recordType === "terminal" &&
          objectValue(source.publicPayload).status === "deleted") continue;
      const recordType = String(source.recordType) as SessionRecordType;
      const payload = objectValue(source.publicPayload);
      await appendLedger(sql, binding, recordType, {
        ...payload,
        _forkedFrom: {
          sessionId: source.sessionId,
          sequence: source.sequence,
          recordHash: source.recordHash,
          ...(typeof body.parentThreadId === "string"
            ? { parentThreadId: body.parentThreadId }
            : {}),
        },
      }, {
        producer: safeProducer(source),
      });
      copied += 1;
    }
    return { copied };
  }
  if (method === "restore") {
    const binding = requireBinding(sql);
    const restoreInput = objectValue(body.input);
    const jsonl = typeof restoreInput.jsonl === "string" ? restoreInput.jsonl : "";
    const retarget = restoreInput.retarget === true;
    if (!jsonl) throw new Error("A flary-jsonl archive is required");
    const imported = await importSessionJsonl(jsonl);
    for (const record of imported) {
      if (
        record.tenantId !== binding.thread.organizationId ||
        record.applicationId !== binding.thread.appId ||
        (!retarget && (
          record.sessionId !== binding.thread.threadId ||
          record.threadId !== binding.thread.threadId
        ))
      ) {
        throw new Error("The archive does not belong to this thread");
      }
    }
    if (restoreInput.replace !== false) {
      const bucket = host?.env?.FLARY_SESSION_ARCHIVE as SessionArchiveBucket | undefined;
      const secret = typeof host?.env?.FLARY_SESSION_ARCHIVE_KEY === "string"
        ? host.env.FLARY_SESSION_ARCHIVE_KEY
        : undefined;
      if (bucket && secret) {
        await new R2SessionArchive({ sql, bucket, secret }).deleteSession(
          binding.thread.threadId,
        );
        await new SqliteCanonicalSessionArchive({ sql, bucket, secret }).deleteSession(
          binding.thread.threadId,
        );
      }
      sql.exec("DROP TABLE IF EXISTS flary_session_ledger_records");
      sql.exec("DROP TABLE IF EXISTS flary_session_ledger_metadata");
      sql.exec("DROP TABLE IF EXISTS flary_session_archive_segments");
      sql.exec("DELETE FROM flary_session_projection_dedupe");
    }
    const ledger = new SqliteSessionLedger(sql);
    for (const record of imported) {
      if (!retarget) {
        await ledger.appendRecord(record);
        continue;
      }
      await ledger.append({
        tenantId: binding.thread.organizationId,
        applicationId: binding.thread.appId,
        sessionId: binding.thread.threadId,
        threadId: binding.thread.threadId,
        ...(record.turnId ? { turnId: record.turnId } : {}),
        ...(record.runId ? { runId: record.runId } : {}),
        ...(record.agentId ? { agentId: record.agentId } : {}),
        ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
        ...(record.parentId ? { parentId: record.parentId } : {}),
        sourceCursor: `import:${record.recordHash}`,
        recordType: record.recordType,
        recordedAt: record.recordedAt,
        attempt: record.attempt,
        sourceRevision: record.sourceRevision,
        ...(record.producer ? { producer: record.producer } : {}),
        publicPayload: {
          ...record.publicPayload,
          _restoredFrom: {
            sessionId: record.sessionId,
            sequence: record.sequence,
            recordHash: record.recordHash,
          },
        },
        ...(record.encryptedContentRef
          ? { encryptedContentRef: record.encryptedContentRef }
          : {}),
      });
    }
    put(sql, "restore-state", {
      restoredAt: new Date().toISOString(),
      recordCount: imported.length,
      flueReplayRequired: true,
    });
    const canonicalArchive = canonicalArchiveFor(sql, host?.env);
    return {
      restored: true,
      recordCount: imported.length,
      latestSequence: imported.at(-1)?.sequence ?? 0,
      canonicalArchiveCount: canonicalArchive
        ? (await canonicalArchive.list(binding.thread.threadId)).length
        : 0,
      // Flue remains the canonical transcript. The host must attach a Flue
      // archive importer before model execution can resume from these records.
      flueReplayRequired: true,
    };
  }
  if (method === "admitTurn") {
    const binding = requireBinding(sql);
    const admissionId = String(body.admissionId ?? "");
    const existing = sql.exec<{ admission_id: string }>(
      "SELECT admission_id FROM flary_interactive_admissions WHERE admission_id = ?",
      admissionId,
    ).toArray()[0];
    if (existing) return { admitted: true, replay: true };
    await reserveRootInteractiveUsage(sql, host?.env, binding, {
      reservationId: `turn_${admissionId}`,
      kind: "provider-step",
      delta: emptyUsage({ steps: 1 }),
    });
    return sql.transactionSync(() => {
      sql.exec(
        `INSERT INTO flary_interactive_admissions
          (admission_id, admitted_at) VALUES (?, ?)`,
        admissionId,
        new Date().toISOString(),
      );
      return { admitted: true, replay: false };
    });
  }
  if (
    method === "reserveUsage" ||
    method === "settleUsage" ||
    method === "unknownUsage"
  ) {
    const binding = requireBinding(sql);
    return rootInteractiveReservationAction(
      sql,
      host?.env,
      binding,
      method,
      body,
    );
  }
  if (method === "track") {
    const binding = requireBinding(sql);
    const admission = body.admission as FlueAdmission;
    put(sql, `projection:${admission.submissionId}`, {
      admission,
      agentId: String(body.agentId ?? binding.agentId),
      instanceId: String(body.instanceId ?? threadName(binding.thread)),
      ...(body.modelPin ? { modelPin: body.modelPin } : {}),
      ...(typeof body.admissionId === "string"
        ? { admissionId: body.admissionId }
        : {}),
      ...(typeof body.segmentId === "string" ? { segmentId: body.segmentId } : {}),
      ...(typeof body.turnMessage === "string"
        ? { turnMessage: body.turnMessage }
        : {}),
      status: "active",
    });
    if (!host?.env || !host.execution) {
      throw new Error("Thread projection needs the generated Cloudflare host");
    }
    host.execution.waitUntil(
      projectAdmission({
        sql,
        env: host.env,
        binding,
        admission,
        admissionId:
          typeof body.admissionId === "string" ? body.admissionId : undefined,
        modelPin: body.modelPin as ResolvedModelPin | undefined,
        segmentId: typeof body.segmentId === "string" ? body.segmentId : undefined,
        turnMessage:
          typeof body.turnMessage === "string" ? body.turnMessage : undefined,
      }),
    );
    await host.storage?.setAlarm?.(Date.now() + 30_000);
    return { tracked: true };
  }
  if (method === "accountUsage") {
    const binding = requireBinding(sql);
    return accountInteractiveDelta(
      sql,
      binding,
      {
        steps: nonnegative(objectValue(body.delta).steps, 0),
        toolCalls: nonnegative(objectValue(body.delta).toolCalls, 0),
        tokens: nonnegative(objectValue(body.delta).tokens, 0),
        costUsd: positiveNumber(objectValue(body.delta).costUsd, 0),
        sandboxSeconds: nonnegative(objectValue(body.delta).sandboxSeconds, 0),
        browserSeconds: nonnegative(objectValue(body.delta).browserSeconds, 0),
      },
    );
  }
  if (method === "subagent") {
    const binding = requireBinding(sql);
    const action = String(body.action);
    const result = subagentAction(sql, binding, action, objectValue(body.input));
    if (action !== "list" && action !== "wait") {
      const recordType: SessionRecordType = action === "spawn"
        ? "subagent.spawned"
        : action === "send"
          ? "subagent.message"
          : action === "close"
            ? "subagent.closed"
            : "subagent.status";
      await appendLedger(sql, binding, recordType, {
        action,
        result: jsonValue(result),
      });
    }
    return result;
  }
  if (method === "process") {
    const binding = requireBinding(sql);
    if (!host?.env) throw new Error("Sandbox processes need the generated Cloudflare host");
    const processInput = objectValue(body.input);
    const reservationId = `sandbox_${String(
      processInput.requestId ?? processInput.processId ?? crypto.randomUUID(),
    )}_${String(body.action ?? "control")}`;
    await reserveRootInteractiveUsage(sql, host.env, binding, {
      reservationId,
      kind: "sandbox",
      delta: emptyUsage({ sandboxSeconds: 1 }),
    });
    const startedAt = Date.now();
    let result: unknown;
    try {
      result = await processAction(
        sql,
        host.env,
        binding,
        String(body.action ?? ""),
        processInput,
      );
    } catch (error) {
      await rootInteractiveReservationAction(
        sql,
        host.env,
        binding,
        "unknownUsage",
        { reservationId },
      ).catch(() => undefined);
      throw error;
    }
    const sandboxDelta: InteractiveUsage = {
      steps: 0,
      toolCalls: 0,
      tokens: 0,
      costUsd: 0,
      sandboxSeconds: Math.max(1, Math.ceil((Date.now() - startedAt) / 1_000)),
      browserSeconds: 0,
    };
    try {
      await rootInteractiveReservationAction(
        sql,
        host.env,
        binding,
        "settleUsage",
        { reservationId, actual: sandboxDelta },
      );
    } catch (error) {
      await rootInteractiveReservationAction(
        sql,
        host.env,
        binding,
        "unknownUsage",
        { reservationId },
      ).catch(() => undefined);
      throw error;
    }
    if (
      typeof binding.metadata?.flarySubagentRootThreadId === "string" &&
      binding.metadata.flarySubagentRootThreadId !== binding.thread.threadId
    ) {
      const localLimit = accountInteractiveDelta(sql, binding, sandboxDelta);
      if (localLimit.exceeded) throw new Error(localLimit.message);
    }
    const action = String(body.action ?? "");
    const recordType: SessionRecordType = action === "start"
      ? "process.started"
      : action === "attach" || action === "list"
        ? "process.output"
        : action === "complete"
          ? "process.completed"
          : "process.control";
    await appendLedger(sql, binding, recordType, {
      action,
      processId: objectValue(body.input).processId,
      result: jsonValue(result),
    });
    return result;
  }
  if (method === "browser") {
    const binding = requireBinding(sql);
    const action = String(body.action ?? "status");
    const browserInput = objectValue(body.input);
    const accounted = action !== "status" && action !== "register";
    const reservationId = `browser_${String(
      browserInput.requestId ?? crypto.randomUUID(),
    )}_${action}`;
    if (accounted) {
      await reserveRootInteractiveUsage(sql, host?.env, binding, {
        reservationId,
        kind: "browser",
        delta: emptyUsage({ browserSeconds: 1 }),
      });
    }
    const startedAt = Date.now();
    let result: unknown;
    try {
      result = await browserAction(
        sql,
        host?.env,
        binding,
        action,
        browserInput,
      );
    } catch (error) {
      if (accounted) {
        await rootInteractiveReservationAction(
          sql,
          host?.env,
          binding,
          "unknownUsage",
          { reservationId },
        ).catch(() => undefined);
      }
      throw error;
    }
    if (accounted) {
      const browserDelta: InteractiveUsage = {
        steps: 0,
        toolCalls: 0,
        tokens: 0,
        costUsd: 0,
        sandboxSeconds: 0,
        browserSeconds: Math.max(1, Math.ceil((Date.now() - startedAt) / 1_000)),
      };
      try {
        await rootInteractiveReservationAction(
          sql,
          host?.env,
          binding,
          "settleUsage",
          { reservationId, actual: browserDelta },
        );
      } catch (error) {
        await rootInteractiveReservationAction(
          sql,
          host?.env,
          binding,
          "unknownUsage",
          { reservationId },
        ).catch(() => undefined);
        throw error;
      }
      if (
        typeof binding.metadata?.flarySubagentRootThreadId === "string" &&
        binding.metadata.flarySubagentRootThreadId !== binding.thread.threadId
      ) {
        const localLimit = accountInteractiveDelta(sql, binding, browserDelta);
        if (localLimit.exceeded) throw new Error(localLimit.message);
      }
    }
    if (action !== "status") {
      await appendLedger(sql, binding, "runtime.event", {
        type: "browser.control",
        action,
        result: jsonValue(result),
      });
    }
    return result;
  }
  if (method === "schedule") {
    const result = await scheduleAction(
      sql,
      requireBinding(sql),
      String(body.action ?? ""),
      objectValue(body.input),
    );
    await scheduleNextAlarm(sql, host?.storage);
    return result;
  }
  if (method === "records" || method === "export") {
    const binding = requireBinding(sql);
    const records = await readLedger(
      sql,
      binding.thread.threadId,
      method === "records" ? numericValue(body.after, 0) : 0,
      method === "records" ? positive(body.limit, 100) : 1_000_000,
      host?.env,
    );
    if (method === "export") {
      return { jsonl: exportSessionJsonl(records) };
    }
    const families = Array.isArray(body.families)
      ? body.families.map(String)
      : [];
    const types = Array.isArray(body.types) ? body.types.map(String) : [];
    return {
      records: records.filter((record) =>
        (families.length === 0 ||
          families.some((family) => record.recordType.startsWith(family))) &&
        (types.length === 0 || types.includes(record.recordType))),
    };
  }
  const binding = requireBinding(sql);
  const update = objectValue(body.input);
  const metadata = { ...(binding.metadata ?? {}) };
  if (method === "archive") binding.status = "archived";
  if (method === "unarchive") binding.status = "active";
  if (method === "rename" && typeof update.title === "string") {
    metadata.title = update.title;
  }
  if (method === "pin") {
    metadata.pinned =
      typeof update.pinned === "boolean" ? update.pinned : true;
  }
  if (method === "markRead") {
    metadata.readThroughSequence =
      typeof update.throughSequence === "number"
        ? update.throughSequence
        : 0;
  }
  if (method === "setMode") binding.defaultMode = String(update.mode) as ThreadBinding["defaultMode"];
  if (method === "setConnections") {
    binding.connectionIds = Array.isArray(update.connectionIds)
      ? update.connectionIds.map(String)
      : [];
  }
  binding.metadata = metadata;
  binding.updatedAt = new Date().toISOString();
  const parsed = ThreadBindingSchema.parse(binding);
  put(sql, "binding", parsed);
  await appendLedger(sql, parsed, "session.lifecycle", { action: method });
  return { binding: parsed };
}

/** Run due schedules from the generated Thread Control Durable Object alarm. */
export async function handleFlaryThreadControlAlarm(input: {
  readonly storage: ThreadControlStorage;
  readonly env: Record<string, unknown>;
  readonly execution?: ThreadControlExecutionContext;
}): Promise<void> {
  const storage = normalizeThreadControlStorage(input.storage);
  const binding = requireBinding(storage.sql);
  const projections = storage.sql.exec<{ value_json: string }>(
    `SELECT value_json FROM flary_thread_control
     WHERE key LIKE 'projection:%'`,
  ).toArray().map((row) => objectValue(JSON.parse(row.value_json)))
    .filter((projection) => projection.status !== "completed");
  for (const projection of projections) {
    const admission = projection.admission as FlueAdmission | undefined;
    if (!admission) continue;
    const work = projectAdmission({
      sql: storage.sql,
      env: input.env,
      binding,
      admission,
      admissionId:
        typeof projection.admissionId === "string"
          ? projection.admissionId
          : undefined,
      modelPin: projection.modelPin as ResolvedModelPin | undefined,
      segmentId: typeof projection.segmentId === "string" ? projection.segmentId : undefined,
      turnMessage:
        typeof projection.turnMessage === "string"
          ? projection.turnMessage
          : undefined,
    });
    input.execution?.waitUntil(work);
  }
  const now = Date.now();
  const due = storage.sql.exec<{
    schedule_id: string;
    schedule_json: string;
    next_run_at: number;
  }>(
    `SELECT schedule_id, schedule_json, next_run_at
     FROM flary_thread_schedules
     WHERE enabled = 1 AND next_run_at <= ?
     ORDER BY next_run_at ASC
     LIMIT 100`,
    now,
  ).toArray();
  const gateway = createCloudflareFlueGateway(input.env, {
    token:
      typeof input.env.FLARY_INTERNAL_TOKEN === "string"
        ? input.env.FLARY_INTERNAL_TOKEN
        : undefined,
  });
  for (const row of due) {
    const schedule = objectValue(JSON.parse(row.schedule_json));
    const scheduledFor = Number(row.next_run_at);
    const claimed = storage.sql.transactionSync(() => {
      const existing = storage.sql.exec<{ status: string }>(
        `SELECT status FROM flary_thread_schedule_runs
         WHERE schedule_id = ? AND scheduled_for = ?`,
        row.schedule_id,
        scheduledFor,
      ).toArray()[0];
      if (existing) return false;
      const nextRunAt = nextScheduleTime(schedule, scheduledFor);
      storage.sql.exec(
        `INSERT INTO flary_thread_schedule_runs
          (schedule_id, scheduled_for, status, created_at, updated_at)
         VALUES (?, ?, 'claimed', ?, ?)`,
        row.schedule_id,
        scheduledFor,
        new Date().toISOString(),
        new Date().toISOString(),
      );
      storage.sql.exec(
        `UPDATE flary_thread_schedules
         SET next_run_at = ?, enabled = ?, updated_at = ?
         WHERE schedule_id = ? AND next_run_at = ?`,
        nextRunAt ?? scheduledFor,
        nextRunAt === undefined ? 0 : 1,
        new Date().toISOString(),
        row.schedule_id,
        scheduledFor,
      );
      return true;
    });
    if (!claimed) continue;
    try {
      const admissionId = `schedule_${row.schedule_id}_${scheduledFor}`;
      await reserveRootInteractiveUsage(storage.sql, input.env, binding, {
        reservationId: `turn_${admissionId}`,
        kind: "provider-step",
        delta: emptyUsage({ steps: 1 }),
      });
      const admission = await gateway.send(
        runtimeAgentId(binding),
        threadName(binding.thread),
        String(schedule.message ?? ""),
      );
      storage.sql.exec(
        `UPDATE flary_thread_schedule_runs
         SET status = 'admitted', admission_json = ?, updated_at = ?
         WHERE schedule_id = ? AND scheduled_for = ?`,
        JSON.stringify(admission),
        new Date().toISOString(),
        row.schedule_id,
        scheduledFor,
      );
      const projection = projectAdmission({
        sql: storage.sql,
        env: input.env,
        binding,
        admission,
        admissionId,
      });
      input.execution?.waitUntil(projection);
      await appendLedger(storage.sql, binding, "schedule.run", {
        scheduleId: row.schedule_id,
        scheduledFor,
        admission,
      });
    } catch (error) {
      storage.sql.exec(
        `UPDATE flary_thread_schedule_runs
         SET status = 'failed', error = ?, updated_at = ?
         WHERE schedule_id = ? AND scheduled_for = ?`,
        error instanceof Error ? error.message : String(error),
        new Date().toISOString(),
        row.schedule_id,
        scheduledFor,
      );
    }
  }
  await scheduleNextAlarm(storage.sql, storage);
  if (projections.length > 0 && storage.setAlarm) {
    await storage.setAlarm(Date.now() + 30_000);
  }
}

interface RealtimeSocketAttachment {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly threadId: string;
  readonly includeChildren: boolean;
  readonly actor: Record<string, unknown>;
  readonly sent: number;
  readonly acknowledged: number;
}

async function openThreadControlWebSocket(
  sql: ThreadControlStorage["sql"],
  input: {
    readonly request: Request;
    readonly webSockets?: ThreadControlWebSocketHost;
  },
): Promise<Response> {
  if (!input.webSockets) {
    return Response.json(
      { error: "The Durable Object WebSocket host is not configured" },
      { status: 501 },
    );
  }
  const ticket = new URL(input.request.url).searchParams.get("ticket") ?? "";
  const ticketHash = await sha256Text(ticket);
  const row = sql.exec<{
    expires_at: string;
    after_sequence: number;
    include_children: number;
    actor_json: string;
    consumed_at: string | null;
  }>(
    `SELECT expires_at, after_sequence, include_children, actor_json, consumed_at
     FROM flary_realtime_tickets WHERE ticket_hash = ?`,
    ticketHash,
  ).toArray()[0];
  if (!row || row.consumed_at || Date.parse(row.expires_at) <= Date.now()) {
    return Response.json({ error: "The realtime ticket is invalid or expired" }, { status: 401 });
  }
  const binding = requireBinding(sql);
  const consumed = sql.transactionSync(() => {
    const current = sql.exec<{ consumed_at: string | null }>(
      "SELECT consumed_at FROM flary_realtime_tickets WHERE ticket_hash = ?",
      ticketHash,
    ).toArray()[0];
    if (!current || current.consumed_at) return false;
    sql.exec(
      "UPDATE flary_realtime_tickets SET consumed_at = ? WHERE ticket_hash = ?",
      new Date().toISOString(),
      ticketHash,
    );
    return true;
  });
  if (!consumed) {
    return Response.json({ error: "The realtime ticket was already used" }, { status: 409 });
  }
  const Pair = (globalThis as unknown as {
    WebSocketPair?: new () => { 0: ThreadControlWebSocket; 1: ThreadControlWebSocket };
  }).WebSocketPair;
  if (!Pair) {
    return Response.json({ error: "WebSocketPair is not available" }, { status: 501 });
  }
  const pair = new Pair();
  const client = pair[0];
  const server = pair[1];
  const attachment: RealtimeSocketAttachment = {
    tenantId: binding.thread.organizationId,
    applicationId: binding.thread.appId,
    threadId: binding.thread.threadId,
    includeChildren: row.include_children === 1,
    actor: objectValue(JSON.parse(row.actor_json)),
    sent: Math.max(0, Number(row.after_sequence)),
    acknowledged: Math.max(0, Number(row.after_sequence)),
  };
  server.serializeAttachment?.(attachment);
  input.webSockets.acceptWebSocket(server, [
    `thread:${binding.thread.threadId}`,
    attachment.includeChildren ? "children:included" : "children:excluded",
  ]);
  const metadata = await new SqliteSessionLedger(sql).metadata(binding.thread.threadId);
  server.send(JSON.stringify({
    version: 1,
    type: "ready",
    threadId: binding.thread.threadId,
    cursor: metadata?.latestSequence ?? 0,
  } satisfies RealtimeServerFrame));
  await sendThreadRecords(sql, server, attachment);
  return new Response(null, {
    status: 101,
    webSocket: client,
  } as ResponseInit & { webSocket: ThreadControlWebSocket });
}

/** Process a client frame after the Thread Control object wakes from hibernation. */
export async function handleFlaryThreadControlWebSocketMessage(input: {
  readonly storage: ThreadControlStorage;
  readonly env: Record<string, unknown>;
  readonly socket: ThreadControlWebSocket;
  readonly message: string | ArrayBuffer;
}): Promise<void> {
  const storage = normalizeThreadControlStorage(input.storage);
  const attachment = realtimeAttachment(input.socket);
  let frame: RealtimeClientFrame;
  try {
    const text = typeof input.message === "string"
      ? input.message
      : new TextDecoder().decode(input.message);
    frame = RealtimeClientFrameSchema.parse(JSON.parse(text));
  } catch (error) {
    input.socket.send(JSON.stringify({
      version: 1,
      type: "error",
      code: "invalid_frame",
      message: error instanceof Error ? error.message : "The realtime frame is invalid",
    } satisfies RealtimeServerFrame));
    return;
  }
  if (frame.type === "ping") {
    input.socket.send(JSON.stringify({
      version: 1,
      type: "pong",
      ...(frame.requestId ? { requestId: frame.requestId } : {}),
    } satisfies RealtimeServerFrame));
    return;
  }
  if (frame.type === "ack") {
    input.socket.serializeAttachment?.({
      ...attachment,
      acknowledged: Math.max(attachment.acknowledged, frame.cursor),
    } satisfies RealtimeSocketAttachment);
    return;
  }
  const now = new Date().toISOString();
  const existing = storage.sql.exec<{ status: string; result_json: string | null }>(
    `SELECT status, result_json FROM flary_realtime_commands
     WHERE idempotency_key = ?`,
    frame.idempotencyKey,
  ).toArray()[0];
  if (existing) {
    input.socket.send(JSON.stringify({
      version: 1,
      type: "accepted",
      requestId: frame.requestId,
      duplicate: true,
    } satisfies RealtimeServerFrame));
    if (existing.result_json) {
      const stored = objectValue(JSON.parse(existing.result_json));
      input.socket.send(JSON.stringify(stored.error
        ? {
            version: 1,
            type: "error",
            requestId: frame.requestId,
            code: String(objectValue(stored.error).code ?? "command_failed"),
            message: String(objectValue(stored.error).message ?? "The realtime command failed"),
          }
        : { version: 1, type: "result", requestId: frame.requestId, result: stored.result }));
    }
    return;
  }
  storage.sql.exec(
    `INSERT INTO flary_realtime_commands
      (idempotency_key, request_id, command, status, result_json, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', NULL, ?, ?)`,
    frame.idempotencyKey,
    frame.requestId,
    frame.command,
    now,
    now,
  );
  input.socket.send(JSON.stringify({
    version: 1,
    type: "accepted",
    requestId: frame.requestId,
    duplicate: false,
  } satisfies RealtimeServerFrame));
  const queue = input.env.FLARY_SESSION_PROJECTION_QUEUE as ProjectionQueue | undefined;
  if (!queue) {
    await storeRealtimeCommandFailure(storage.sql, frame, "realtime_queue_missing", "The realtime command queue is not configured");
    input.socket.send(JSON.stringify({
      version: 1,
      type: "error",
      requestId: frame.requestId,
      code: "realtime_queue_missing",
      message: "The realtime command queue is not configured",
    } satisfies RealtimeServerFrame));
    return;
  }
  await queue.send({
    kind: "realtime.command",
    controlName: `thread:${attachment.tenantId}:${attachment.applicationId}:${attachment.threadId}`,
    target: {
      authorization: {
        organizationId: attachment.tenantId,
        actor: attachment.actor,
      },
      appId: attachment.applicationId,
      threadId: attachment.threadId,
    },
    frame,
  });
}

/** Close hook for generated hibernating WebSocket Durable Objects. */
export function handleFlaryThreadControlWebSocketClose(input: {
  readonly socket: ThreadControlWebSocket;
  readonly code?: number;
  readonly reason?: string;
}): void {
  input.socket.close(input.code ?? 1000, input.reason ?? "closed");
}

async function broadcastThreadRecords(
  sql: ThreadControlStorage["sql"],
  host?: ThreadControlWebSocketHost,
): Promise<void> {
  for (const socket of host?.getWebSockets() ?? []) {
    await sendThreadRecords(sql, socket, realtimeAttachment(socket));
  }
}

async function sendThreadRecords(
  sql: ThreadControlStorage["sql"],
  socket: ThreadControlWebSocket,
  attachment: RealtimeSocketAttachment,
): Promise<void> {
  const page = await new SqliteSessionLedger(sql).list(attachment.threadId, {
    ...(attachment.sent > 0 ? { after: `v1:${attachment.sent}` } : {}),
    limit: 500,
  });
  if (page.items.length === 0) return;
  const cursor = page.items.at(-1)!.sequence;
  const visible = attachment.includeChildren
    ? page.items
    : page.items.filter((record) => !objectValue(record.publicPayload)._child);
  if (visible.length > 0) {
    socket.send(JSON.stringify({
      version: 1,
      type: "events",
      cursor,
      records: visible,
    } satisfies RealtimeServerFrame));
  }
  socket.serializeAttachment?.({ ...attachment, sent: cursor });
  if (page.nextCursor) {
    socket.send(JSON.stringify({
      version: 1,
      type: "resync_required",
      cursor,
    } satisfies RealtimeServerFrame));
  }
}

function realtimeAttachment(socket: ThreadControlWebSocket): RealtimeSocketAttachment {
  const value = socket.deserializeAttachment?.();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The realtime connection has no durable attachment");
  }
  return value as RealtimeSocketAttachment;
}

async function storeRealtimeCommandFailure(
  sql: ThreadControlStorage["sql"],
  frame: Extract<RealtimeClientFrame, { type: "command" }>,
  code: string,
  message: string,
): Promise<void> {
  sql.exec(
    `UPDATE flary_realtime_commands SET status = 'failed', result_json = ?, updated_at = ?
     WHERE idempotency_key = ?`,
    JSON.stringify({ error: { code, message } }),
    new Date().toISOString(),
    frame.idempotencyKey,
  );
}

/** Deliver queued canonical projection work to its Thread Control object. */
export async function handleFlarySessionProjectionQueue(input: {
  readonly messages: readonly ProjectionQueueMessage[];
  readonly env: Record<string, unknown>;
}): Promise<void> {
  const namespace = input.env.FLARY_THREAD_CONTROL as
    | DurableObjectNamespace
    | undefined;
  if (!namespace) throw new Error("FLARY_THREAD_CONTROL is not configured");
  await Promise.all(
    input.messages.map(async (message) => {
      const body = objectValue(message.body);
      const controlName = String(body.controlName ?? "");
      if (!controlName) {
        message.ack();
        return;
      }
      try {
        if (body.kind === "realtime.command") {
          await executeRealtimeCommand(input.env, body, controlName);
          message.ack();
          return;
        }
        const stub = namespace.get(namespace.idFromName(controlName));
        const method = body.kind === "child.projection" ? "projectChild" : "track";
        const response = await stub.fetch(
          new Request("https://flary.internal/track", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...body, method }),
          }),
        );
        if (!response.ok) throw new Error(`Projection failed (${response.status})`);
        message.ack();
      } catch {
        message.retry();
      }
    }),
  );
}

async function executeRealtimeCommand(
  env: Record<string, unknown>,
  body: Record<string, unknown>,
  controlName: string,
): Promise<void> {
  const target = body.target as FlaryThreadTarget | undefined;
  const parsed = RealtimeClientFrameSchema.safeParse(body.frame);
  if (!target || !parsed.success || parsed.data.type !== "command") {
    throw new Error("The queued realtime command is invalid");
  }
  const frame = parsed.data;
  const service = createCloudflareThreadService({ env });
  let result: unknown;
  let error: { code: string; message: string } | undefined;
  try {
    if (frame.command === "send" || frame.command === "steer") {
      result = await service.submit(target, ThreadMessageRequestSchema.parse({
        ...frame.input,
        mode: frame.command === "steer" ? "steer" : "queue",
        idempotencyKey: frame.idempotencyKey,
      }));
    } else if (frame.command === "interrupt") {
      if (!service.interrupt) throw new Error("Thread interrupt is not configured");
      result = await service.interrupt(target);
    } else if (frame.command === "approve" || frame.command === "reject") {
      const requestId = String(frame.input.requestId ?? "");
      await service.decideApproval(target, ApprovalDecisionSchema.parse({
        requestId,
        status: frame.command === "approve" ? "approved" : "rejected",
        decidedBy: target.authorization.actor,
        decidedAt: new Date().toISOString(),
        ...(typeof frame.input.reason === "string" ? { comment: frame.input.reason } : {}),
      }));
      result = { ok: true };
    } else if (frame.command === "user_input") {
      if (!service.respondToUserInput) throw new Error("User input is not configured");
      result = await service.respondToUserInput(
        target,
        String(frame.input.requestId ?? ""),
        UserInputAnswerRequestSchema.parse(frame.input.response),
      );
    } else if (frame.command === "subagent") {
      if (!service.subagentAction) throw new Error("Subagent control is not configured");
      result = await service.subagentAction(
        target,
        String(frame.input.action ?? ""),
        objectValue(frame.input.input),
      );
    } else if (frame.command.startsWith("process.")) {
      if (!service.processAction) throw new Error("Sandbox process control is not configured");
      result = await service.processAction(
        target,
        frame.command.slice("process.".length),
        frame.input,
      );
    } else if (frame.command.startsWith("browser.")) {
      if (!service.browserAction) throw new Error("Browser Run control is not configured");
      result = await service.browserAction(
        target,
        frame.command.slice("browser.".length),
        frame.input,
      );
    } else {
      throw new FlaryHostError(
        501,
        "realtime_command_not_configured",
        `The '${frame.command}' realtime command is not configured`,
      );
    }
  } catch (cause) {
    error = {
      code: cause instanceof FlaryHostError ? cause.code : "command_failed",
      message: cause instanceof Error ? cause.message : "The realtime command failed",
    };
  }
  const namespace = env.FLARY_THREAD_CONTROL as DurableObjectNamespace;
  const response = await namespace.get(namespace.idFromName(controlName)).fetch(
    new Request("https://flary.internal/realtime-result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "realtimeResult",
        tenantId: target.authorization.organizationId,
        applicationId: target.appId,
        idempotencyKey: frame.idempotencyKey,
        requestId: frame.requestId,
        ...(error ? { error } : { result }),
      }),
    }),
  );
  if (!response.ok) throw new Error("The realtime result was not stored");
}

async function processAction(
  sql: ThreadControlStorage["sql"],
  env: Record<string, unknown>,
  binding: ThreadBinding,
  action: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const sandboxBinding = env.SANDBOX;
  if (!sandboxBinding) throw new Error("The SANDBOX binding is not configured");
  const { getSandbox } = await import("@cloudflare/sandbox");
  const sandboxId = `flary-${binding.thread.organizationId}-${binding.thread.threadId}`;
  const sandbox = getSandbox(sandboxBinding as never, sandboxId, {
    transport: "rpc",
    sleepAfter: "10m",
    enableDefaultSession: true,
    normalizeId: true,
    labels: { threadId: binding.thread.threadId },
  });
  const registry = new SqliteSandboxProcessRegistry(sql);
  const workspaceNamespace = env.FLARY_WORKSPACE as
    | DurableObjectNamespace
    | undefined;
  const workspaceBackend = workspaceNamespace
    ? new CloudflareSandboxWorkspaceBackend({
        sandbox,
        workspace: await createCloudflareWorkspaceConnection(
          workspaceNamespace as never,
          binding.workspace,
        ),
        sql,
        sessionId: binding.thread.threadId,
      })
    : undefined;
  if (workspaceBackend && action === "start") await workspaceBackend.prepare();
  const runtime = new DurableSandboxProcessRuntime({
    sandbox,
    registry,
    onSettled: workspaceBackend
      ? async ({ processId }) => {
          const operationId = `process_${processId}_exit`;
          try {
            await workspaceBackend.settle({ operationId, changed: true });
          } catch (error) {
            await workspaceBackend.uncertain(operationId);
            throw error;
          }
        }
      : undefined,
  });
  if (action === "list") {
    return { processes: await registry.list({ runId: binding.thread.threadId }) };
  }
  const processId = String(input.processId ?? "");
  const requestId = String(input.requestId ?? `control_${crypto.randomUUID()}`);
  if (action === "start") {
    const command = String(input.command ?? "").trim();
    if (!command) throw new Error("A process command is required");
    return runtime.start({
      id: processId || `process_${crypto.randomUUID().replaceAll("-", "")}`,
      runId: binding.thread.threadId,
      sandboxId,
      command,
      cwd: typeof input.cwd === "string" ? input.cwd : "/workspace",
    });
  }
  if (!processId) throw new Error("A process ID is required");
  const process = await registry.get(processId);
  if (!process || process.runId !== binding.thread.threadId) {
    throw new Error("The Sandbox process was not found");
  }
  if (action === "attach") {
    return runtime.attach(processId, nonnegative(input.afterCursor, 0));
  }
  if (action === "stdin") {
    return runtime.stdin({ requestId, processId, data: String(input.data ?? "") });
  }
  if (action === "signal") {
    return runtime.signal({
      requestId,
      processId,
      signal: String(input.signal ?? "SIGTERM") as Parameters<typeof runtime.signal>[0]["signal"],
    });
  }
  if (action === "sleep") return runtime.sleep(processId, requestId);
  if (action === "wake") return runtime.wake(processId, requestId);
  if (action === "resize") {
    throw new FlaryHostError(
      501,
      "process_resize_not_supported",
      "Cloudflare Sandbox background processes do not expose PTY resize",
    );
  }
  throw new Error(`Unknown Sandbox process action '${action}'`);
}

async function browserAction(
  sql: ThreadControlStorage["sql"],
  env: Record<string, unknown> | undefined,
  binding: ThreadBinding,
  action: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const currentRow = sql.exec<{ value_json: string }>(
    "SELECT value_json FROM flary_thread_control WHERE key = 'browser-state'",
  ).toArray()[0];
  const current = currentRow
    ? objectValue(JSON.parse(currentRow.value_json))
    : { control: "agent", status: "idle" };
  if (action === "status") return { browser: current };
  if (action === "register") {
    const sessionId = String(input.sessionId ?? "");
    if (!sessionId) throw new Error("A Browser Run session ID is required");
    const state = {
      ...current,
      sessionId,
      status: "active",
      control: current.control === "human" ? "human" : "agent",
      updatedAt: new Date().toISOString(),
    };
    put(sql, "browser-state", state);
    return { browser: state };
  }
  if (action === "takeover" || action === "release") {
    const state = {
      ...current,
      control: action === "takeover" ? "human" : "agent",
      updatedAt: new Date().toISOString(),
    };
    put(sql, "browser-state", state);
    return { browser: state };
  }
  if (action === "input") {
    if (current.control !== "human") {
      throw new Error("Browser input needs an active human takeover");
    }
    if (!env?.BROWSER || typeof current.sessionId !== "string") {
      throw new Error("The Browser Run session is not available");
    }
    const playwright = await import("@cloudflare/playwright");
    const browser = await playwright.connect(env.BROWSER as never, current.sessionId);
    try {
      const context = browser.contexts()[0];
      const page = context?.pages()[0];
      if (!page) throw new Error("The Browser Run page is not available");
      const kind = String(input.kind ?? "");
      if (kind === "click") {
        await page.locator(String(input.selector ?? "")).click();
      } else if (kind === "type") {
        await page.locator(String(input.selector ?? "")).fill(String(input.text ?? "").slice(0, 100_000));
      } else if (kind === "navigate") {
        await page.goto(assertPublicBrowserUrl(String(input.url ?? "")).toString());
      } else {
        throw new Error("Human Browser Run input must be click, type, or navigate");
      }
      return { browser: current, url: page.url(), title: await page.title() };
    } finally {
      await browser.close();
    }
  }
  if (action === "close") {
    put(sql, "browser-state", {
      status: "closed",
      control: "agent",
      updatedAt: new Date().toISOString(),
    });
    return { closed: true };
  }
  throw new Error(`Unknown Browser Run action '${action}'`);
}

async function scheduleAction(
  sql: ThreadControlStorage["sql"],
  binding: ThreadBinding,
  action: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (action === "list") {
    return {
      schedules: sql.exec<{ schedule_json: string }>(
        "SELECT schedule_json FROM flary_thread_schedules ORDER BY schedule_id",
      ).toArray().map((row) => JSON.parse(row.schedule_json)),
    };
  }
  if (action === "history") {
    const scheduleId =
      typeof input.scheduleId === "string" ? input.scheduleId : undefined;
    const rows = sql.exec<Record<string, unknown>>(
      `SELECT run_sequence, schedule_id, scheduled_for, status,
              admission_json, error, created_at, updated_at
       FROM flary_thread_schedule_runs
       ${scheduleId ? "WHERE schedule_id = ?" : ""}
       ORDER BY run_sequence DESC
       LIMIT ?`,
      ...(scheduleId ? [scheduleId] : []),
      positive(input.limit, 100),
    ).toArray();
    return { runs: rows };
  }
  const scheduleId = String(input.scheduleId ?? input.id ?? "");
  if (!scheduleId) throw new Error("A schedule ID is required");
  if (action === "delete") {
    sql.exec("DELETE FROM flary_thread_schedules WHERE schedule_id = ?", scheduleId);
    await appendLedger(sql, binding, "schedule.updated", {
      scheduleId,
      action: "deleted",
    });
    return { deleted: true };
  }
  if (action === "pause" || action === "resume") {
    sql.exec(
      `UPDATE flary_thread_schedules
       SET enabled = ?, updated_at = ?
       WHERE schedule_id = ?`,
      action === "resume" ? 1 : 0,
      new Date().toISOString(),
      scheduleId,
    );
    await appendLedger(sql, binding, "schedule.updated", {
      scheduleId,
      action,
    });
    return { scheduleId, enabled: action === "resume" };
  }
  if (action !== "register") throw new Error(`Unknown schedule action '${action}'`);
  if (typeof input.message !== "string" || input.message.trim().length === 0) {
    throw new Error("A scheduled agent message is required");
  }
  const schedule = {
    id: scheduleId,
    message: input.message,
    trigger: scheduleTrigger(input.trigger),
    enabled: input.enabled !== false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const nextRunAt = nextScheduleTime(schedule, Date.now() - 1);
  if (nextRunAt === undefined) throw new Error("The schedule has no future run");
  sql.exec(
    `INSERT INTO flary_thread_schedules
      (schedule_id, schedule_json, next_run_at, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(schedule_id) DO UPDATE SET
       schedule_json = excluded.schedule_json,
       next_run_at = excluded.next_run_at,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
    scheduleId,
    JSON.stringify(schedule),
    nextRunAt,
    schedule.enabled ? 1 : 0,
    schedule.updatedAt,
  );
  await appendLedger(sql, binding, "schedule.updated", {
    scheduleId,
    action: "registered",
    nextRunAt,
  });
  return { schedule: { ...schedule, nextRunAt } };
}

function scheduleTrigger(value: unknown): Record<string, unknown> {
  const trigger = objectValue(value);
  if (trigger.kind === "interval") {
    const intervalMs = positive(trigger.intervalMs, 0);
    if (intervalMs < 1_000) {
      throw new Error("A schedule interval must be at least 1000 ms");
    }
    return { kind: "interval", intervalMs };
  }
  if (trigger.kind === "once") {
    const at = Date.parse(String(trigger.at ?? ""));
    if (!Number.isFinite(at)) throw new Error("A one-time schedule needs a valid date");
    return { kind: "once", at };
  }
  if (trigger.kind === "cron") {
    const expression = String(trigger.expression ?? "").trim();
    if (!/^(\*|\*\/[1-9][0-9]*|[0-5]?[0-9]) (\*|\*\/[1-9][0-9]*|(?:[01]?[0-9]|2[0-3])) \* \* \*$/.test(expression)) {
      throw new Error("Cron supports minute and hour fields with '*', '*/n', or a fixed value");
    }
    return { kind: "cron", expression, timeZone: "UTC" };
  }
  throw new Error("A schedule trigger must be interval, once, or cron");
}

function nextScheduleTime(
  schedule: Record<string, unknown>,
  after: number,
): number | undefined {
  const trigger = objectValue(schedule.trigger);
  if (trigger.kind === "interval") {
    return after + positive(trigger.intervalMs, 0);
  }
  if (trigger.kind === "once") {
    const at = Number(trigger.at);
    return at > after ? at : undefined;
  }
  if (trigger.kind === "cron") {
    const [minute, hour] = String(trigger.expression).split(" ");
    let candidate = Math.floor(after / 60_000) * 60_000 + 60_000;
    for (let count = 0; count < 527_040; count += 1, candidate += 60_000) {
      const date = new Date(candidate);
      if (cronPart(minute!, date.getUTCMinutes()) && cronPart(hour!, date.getUTCHours())) {
        return candidate;
      }
    }
  }
  return undefined;
}

function cronPart(pattern: string, value: number): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*/")) return value % Number(pattern.slice(2)) === 0;
  return value === Number(pattern);
}

async function scheduleNextAlarm(
  sql: ThreadControlStorage["sql"],
  storage?: ThreadControlStorage,
): Promise<void> {
  if (!storage?.setAlarm) return;
  const row = sql.exec<{ next_run_at: number }>(
    `SELECT next_run_at FROM flary_thread_schedules
     WHERE enabled = 1 ORDER BY next_run_at ASC LIMIT 1`,
  ).toArray()[0];
  if (row) await storage.setAlarm(Number(row.next_run_at));
}

async function projectAdmission(input: {
  readonly sql: ThreadControlStorage["sql"];
  readonly env: Record<string, unknown>;
  readonly binding: ThreadBinding;
  readonly admission: FlueAdmission;
  readonly admissionId?: string;
  readonly modelPin?: ResolvedModelPin;
  readonly segmentId?: string;
  readonly turnMessage?: string;
}): Promise<void> {
  const gateway = createCloudflareFlueGateway(input.env, {
    token:
      typeof input.env.FLARY_INTERNAL_TOKEN === "string"
        ? input.env.FLARY_INTERNAL_TOKEN
        : undefined,
  });
  const ledger = new SqliteSessionLedger(input.sql);
  const projector = new FlarySessionProjector(ledger, {
    tenantId: input.binding.thread.organizationId,
    applicationId: input.binding.thread.appId,
    sessionId: input.binding.thread.threadId,
    threadId: input.binding.thread.threadId,
    agentId: input.binding.agentId,
    sourceRevision:
      typeof input.binding.metadata?.flaryAgentRevision === "string"
        ? input.binding.metadata.flaryAgentRevision
        : "flary-thread-control-v1",
  });
  let providerStepSettled = false;
  try {
    const result = await gateway.wait(input.admission, async (event) => {
      const sourceCursor = canonicalEventCursor(
        input.admission.submissionId,
        event as unknown as Record<string, unknown>,
      );
      const seen = input.sql.exec<{ source_cursor: string }>(
        "SELECT source_cursor FROM flary_session_projection_dedupe WHERE source_cursor = ?",
        sourceCursor,
      ).toArray()[0];
      if (seen) return;
      const providerStepEvent =
        String((event as unknown as Record<string, unknown>).type ?? "") ===
          "message-started" ||
        String((event as unknown as Record<string, unknown>).type ?? "") ===
          "turn_request";
      if (providerStepEvent && input.admissionId && !providerStepSettled) {
        await rootInteractiveReservationAction(
          input.sql,
          input.env,
          input.binding,
          "settleUsage",
          {
            reservationId: `turn_${input.admissionId}`,
            actual: emptyUsage({ steps: 1 }),
          },
        );
        providerStepSettled = true;
      }
      const isChild =
        typeof input.binding.metadata?.flarySubagentRootThreadId === "string" &&
        input.binding.metadata.flarySubagentRootThreadId !==
          input.binding.thread.threadId;
      const limit = accountInteractiveEvent(
        input.sql,
        input.binding,
        providerStepSettled && !isChild
          ? {
              ...(event as unknown as Record<string, unknown>),
              type: providerStepEvent ? "reserved-provider-step" : event.type,
            }
          : event as unknown as Record<string, unknown>,
      );
      const rootDelta = providerStepSettled && providerStepEvent
        ? { ...limit.delta, steps: 0 }
        : limit.delta;
      const rootLimit = await accountRootInteractiveEvent(
        input.env,
        input.binding,
        rootDelta,
      );
      const projectedEvent = input.modelPin
        ? {
            ...(event as unknown as Record<string, unknown>),
            modelInfo: {
              provider: input.modelPin.provider,
              model: input.modelPin.model,
              ...(input.modelPin.variant
                ? { variant: input.modelPin.variant }
                : {}),
            },
          }
        : event as unknown as Record<string, unknown>;
      const projected = await projector.project({
        sourceCursor,
        event: projectedEvent,
      });
      await mirrorChildProjection(input, projected, sourceCursor);
      if (
        projected.recordType === "approval.requested" ||
        projected.recordType === "input.requested"
      ) {
        await updateSubagentAtRoot(input, "wait", sourceCursor, {
          reason: projected.recordType,
        });
      } else if (
        projected.recordType === "approval.resolved" ||
        projected.recordType === "input.resolved"
      ) {
        await updateSubagentAtRoot(input, "resume", sourceCursor, {
          reason: projected.recordType,
        });
      }
      input.sql.exec(
        `INSERT OR IGNORE INTO flary_session_projection_dedupe
          (source_cursor, recorded_at) VALUES (?, ?)`,
        sourceCursor,
        new Date().toISOString(),
      );
      const appliedLimit = limit.exceeded ? limit : rootLimit;
      if (appliedLimit.exceeded) {
        await gateway.abort(
          runtimeAgentId(input.binding),
          threadName(input.binding.thread),
        );
        throw new Error(appliedLimit.message);
      }
      await sealSessionArchiveIfNeeded(
        input.sql,
        input.env,
        input.binding.thread.threadId,
      );
    });
    if (input.modelPin) {
      await appendLedger(input.sql, input.binding, "provider.segment.completed", {
        ...(input.segmentId ? { segmentId: input.segmentId } : {}),
        submissionId: input.admission.submissionId,
        pin: input.modelPin,
        completionReason: "completed",
      });
    }
    await captureCanonicalSnapshot(input, gateway);
    const checkpoint = await checkpointWorkspace(input);
    if (checkpoint) {
      await appendLedger(input.sql, input.binding, "artifact.checkpoint", {
        submissionId: input.admission.submissionId,
        checkpoint,
      });
    }
    const childResult = subagentResult(
      result,
      checkpoint,
      interactiveUsage(input.sql),
    );
    await settleSubagent(input, "complete", { output: childResult });
    await recordSubagentTurn(input, result);
    // Settle last. An eviction before this write causes the alarm to replay
    // checkpointing and parent propagation instead of leaving a child stuck.
    put(input.sql, `projection:${input.admission.submissionId}`, {
      admission: input.admission,
      status: "completed",
    });
  } catch (error) {
    if (input.admissionId && !providerStepSettled) {
      await rootInteractiveReservationAction(
        input.sql,
        input.env,
        input.binding,
        "unknownUsage",
        { reservationId: `turn_${input.admissionId}` },
      ).catch(() => undefined);
    }
    put(input.sql, `projection:${input.admission.submissionId}`, {
      admission: input.admission,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    if (input.modelPin) {
      await appendLedger(input.sql, input.binding, "provider.segment.completed", {
        ...(input.segmentId ? { segmentId: input.segmentId } : {}),
        submissionId: input.admission.submissionId,
        pin: input.modelPin,
        completionReason: "failed",
      }).catch(() => undefined);
    }
    await settleSubagent(input, "fail", {
      error: {
        code: "subagent_execution_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    }).catch(() => undefined);
    throw error;
  }
}

async function mirrorChildProjection(
  input: {
    readonly env: Record<string, unknown>;
    readonly binding: ThreadBinding;
  },
  record: SessionRecord,
  sourceCursor: string,
): Promise<void> {
  const rootThreadId = input.binding.metadata?.flarySubagentRootThreadId;
  if (
    typeof rootThreadId !== "string" ||
    rootThreadId === input.binding.thread.threadId
  ) return;
  const controlName =
    `thread:${input.binding.thread.organizationId}:${input.binding.thread.appId}:${rootThreadId}`;
  const body = {
    kind: "child.projection",
    controlName,
    tenantId: input.binding.thread.organizationId,
    applicationId: input.binding.thread.appId,
    childThreadId: input.binding.thread.threadId,
    childAgentId: input.binding.agentId,
    sourceCursor: `child:${input.binding.thread.threadId}:${sourceCursor}`,
    recordType: record.recordType,
    recordedAt: record.recordedAt,
    attempt: record.attempt,
    sourceRevision: record.sourceRevision,
    ...(record.producer ? { producer: record.producer } : {}),
    payload: record.publicPayload,
  };
  const queue = input.env.FLARY_SESSION_PROJECTION_QUEUE as
    | ProjectionQueue
    | undefined;
  if (queue) {
    await queue.send(body);
    return;
  }
  const namespace = input.env.FLARY_THREAD_CONTROL as
    | DurableObjectNamespace
    | undefined;
  if (!namespace) {
    throw new Error("Child event projection needs Thread Control or its Queue");
  }
  const response = await namespace.get(namespace.idFromName(controlName)).fetch(
    new Request("https://flary.internal/project-child", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, method: "projectChild" }),
    }),
  );
  if (!response.ok) throw new Error("The root thread rejected a child event");
}

async function recordSubagentTurn(
  input: {
    readonly sql: ThreadControlStorage["sql"];
    readonly env: Record<string, unknown>;
    readonly binding: ThreadBinding;
    readonly admission: FlueAdmission;
    readonly turnMessage?: string;
  },
  result: unknown,
): Promise<void> {
  const turn = {
    id: `turn_${input.admission.submissionId}`.slice(0, 200),
    sessionId:
      typeof input.binding.metadata?.flarySubagentRootThreadId === "string"
        ? input.binding.metadata.flarySubagentRootThreadId
        : input.binding.thread.threadId,
    threadId: input.binding.thread.threadId,
    ordinal: Date.now(),
    messages: [
      ...(input.turnMessage
        ? [{ role: "user", content: input.turnMessage }]
        : []),
      { role: "assistant", content: summarizeSubagentResult(result) },
    ],
    createdAt: new Date().toISOString(),
  };
  const rootThreadId = input.binding.metadata?.flarySubagentRootThreadId;
  if (typeof rootThreadId !== "string") {
    subagentAction(input.sql, input.binding, "turn", { turn });
    return;
  }
  const namespace = input.env.FLARY_THREAD_CONTROL as
    | DurableObjectNamespace
    | undefined;
  if (!namespace) return;
  const name =
    `thread:${input.binding.thread.organizationId}:${input.binding.thread.appId}:${rootThreadId}`;
  const response = await namespace.get(namespace.idFromName(name)).fetch(
    new Request("https://flary.internal/subagent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "subagent",
        tenantId: input.binding.thread.organizationId,
        applicationId: input.binding.thread.appId,
        action: "turn",
        input: { turn },
      }),
    }),
  );
  if (!response.ok) throw new Error("The parent did not accept the child turn");
}

async function checkpointWorkspace(input: {
  readonly env: Record<string, unknown>;
  readonly binding: ThreadBinding;
  readonly admission: FlueAdmission;
  readonly modelPin?: ResolvedModelPin;
}): Promise<unknown | undefined> {
  const namespace = input.env.FLARY_WORKSPACE as
    | DurableObjectNamespace
    | undefined;
  if (!namespace || !input.env.WORKSPACE_BLOBS) return undefined;
  return workspaceControl(input.env, input.binding, "__checkpoint", {
    id: `checkpoint_${input.admission.submissionId}`.slice(0, 200),
    submissionId: input.admission.submissionId,
    sessionId: input.binding.thread.threadId,
    ...(input.modelPin ? { modelPin: input.modelPin } : {}),
  });
}

async function workspaceControl(
  env: Record<string, unknown>,
  binding: ThreadBinding,
  method: "__checkpoint" | "__history" | "__diff" | "__restore" | "__fork",
  value: unknown,
): Promise<any> {
  const namespace = env.FLARY_WORKSPACE as DurableObjectNamespace | undefined;
  if (!namespace) throw new Error("FLARY_WORKSPACE is not configured");
  const name = await cloudflareWorkspaceObjectName(binding.workspace);
  const response = await namespace.get(namespace.idFromName(name)).fetch(
    new Request(`https://flary.internal/workspace/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: binding.workspace, input: value }),
    }),
  );
  const body = await response.json().catch(() => undefined);
  if (!response.ok || !objectValue(body).output) {
    throw new Error(
      typeof objectValue(objectValue(body).error).message === "string"
        ? String(objectValue(objectValue(body).error).message)
        : "Workspace history operation failed",
    );
  }
  return objectValue(body).output;
}

async function settleSubagent(
  input: {
    readonly env: Record<string, unknown>;
    readonly binding: ThreadBinding;
    readonly admission: FlueAdmission;
  },
  action: "complete" | "fail",
  value: Record<string, unknown>,
): Promise<void> {
  await updateSubagentAtRoot(
    input,
    action,
    `settle_${input.admission.submissionId}`,
    value,
  );
  const parentThreadId = input.binding.metadata?.flarySubagentParentThreadId;
  if (action === "complete" && typeof parentThreadId === "string") {
    await sendSubagentResultToParent(
      input,
      parentThreadId,
      `result_${input.admission.submissionId}`,
      value.output,
    );
  }
}

async function updateSubagentAtRoot(
  input: {
    readonly env: Record<string, unknown>;
    readonly binding: ThreadBinding;
    readonly admission: FlueAdmission;
  },
  action: "wait" | "resume" | "complete" | "fail",
  idempotencyKey: string,
  value: Record<string, unknown>,
): Promise<void> {
  const rootThreadId = input.binding.metadata?.flarySubagentRootThreadId;
  if (typeof rootThreadId !== "string") return;
  const namespace = input.env.FLARY_THREAD_CONTROL as
    | DurableObjectNamespace
    | undefined;
  if (!namespace) return;
  const rootName =
    `thread:${input.binding.thread.organizationId}:${input.binding.thread.appId}:${rootThreadId}`;
  const call = async (requestAction: string, requestInput: Record<string, unknown>) => {
    const response = await namespace.get(namespace.idFromName(rootName)).fetch(
      new Request("https://flary.internal/subagent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          method: "subagent",
          tenantId: input.binding.thread.organizationId,
          applicationId: input.binding.thread.appId,
          action: requestAction,
          input: requestInput,
        }),
      }),
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(`Parent subagent update failed: ${JSON.stringify(body)}`);
    }
  };
  await call(action, {
    threadId: input.binding.thread.threadId,
    requestId: idempotencyKey,
    idempotencyKey,
    ...value,
  });
}

async function sendSubagentResultToParent(
  input: {
    readonly env: Record<string, unknown>;
    readonly binding: ThreadBinding;
  },
  parentThreadId: string,
  idempotencyKey: string,
  output: unknown,
): Promise<void> {
  const rootThreadId = input.binding.metadata?.flarySubagentRootThreadId;
  if (typeof rootThreadId !== "string") return;
  const namespace = input.env.FLARY_THREAD_CONTROL as
    | DurableObjectNamespace
    | undefined;
  if (!namespace) return;
  const rootName =
    `thread:${input.binding.thread.organizationId}:${input.binding.thread.appId}:${rootThreadId}`;
  const response = await namespace.get(namespace.idFromName(rootName)).fetch(
    new Request("https://flary.internal/subagent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "subagent",
        tenantId: input.binding.thread.organizationId,
        applicationId: input.binding.thread.appId,
        action: "send",
        input: {
          requestId: idempotencyKey,
          idempotencyKey,
          fromThreadId: input.binding.thread.threadId,
          toThreadId: parentThreadId,
          kind: "result",
          mode: "queue",
          content: summarizeSubagentResult(output),
        },
      }),
    }),
  );
  if (!response.ok) throw new Error("The parent did not accept the child result");
}

function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function summarizeSubagentResult(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.slice(0, 100_000);
  const record = objectValue(value);
  for (const key of ["answer", "summary", "content", "text"]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return record[key].slice(0, 100_000);
    }
  }
  return JSON.stringify(jsonValue(value)).slice(0, 100_000) || "Subagent completed.";
}

function subagentResult(
  value: unknown,
  checkpoint: unknown,
  usage: InteractiveUsage,
): Record<string, unknown> {
  const result = objectValue(value);
  const changedFiles = Array.isArray(result.changedFiles)
    ? result.changedFiles.filter((item): item is string => typeof item === "string").slice(0, 10_000)
    : [];
  const checks = Array.isArray(result.checks)
    ? result.checks.flatMap((item) => {
        const check = objectValue(item);
        if (typeof check.command !== "string") return [];
        const status = check.status === "passed" || check.status === "failed" || check.status === "skipped"
          ? check.status
          : "skipped";
        return [{ command: check.command.slice(0, 16_384), status }];
      }).slice(0, 1_000)
    : [];
  return {
    summary: summarizeSubagentResult(value),
    ...(checkpoint !== undefined ? { checkpoint: jsonValue(checkpoint) } : {}),
    changedFiles,
    checks,
    usage,
    errors: [],
    output: jsonValue(value),
  };
}

function accountInteractiveEvent(
  sql: ThreadControlStorage["sql"],
  binding: ThreadBinding,
  event: Record<string, unknown>,
): {
  exceeded: boolean;
  message: string;
  delta: InteractiveUsage;
} {
  const type = String(event.type ?? "");
  const stepDelta =
    type === "message-started" || type === "turn_request" ? 1 : 0;
  const usage =
    objectValue(event.usage).totalTokens !== undefined
      ? objectValue(event.usage)
      : objectValue(
          objectValue(event.message).metadata &&
            objectValue(objectValue(event.message).metadata).usage,
        );
  const cost = objectValue(usage.cost);
  const costDelta =
    typeof cost.total === "number" && Number.isFinite(cost.total)
      ? cost.total
      : 0;
  const tokenDelta = nonnegative(usage.totalTokens, 0);
  const toolCallDelta = type === "tool-input" ? 1 : 0;
  const delta = {
    steps: stepDelta,
    toolCalls: toolCallDelta,
    tokens: tokenDelta,
    costUsd: costDelta,
    sandboxSeconds: 0,
    browserSeconds: 0,
  };
  if (Object.values(delta).every((value) => value === 0)) {
    return { exceeded: false, message: "", delta };
  }
  return accountInteractiveDelta(sql, binding, delta);
}

function accountInteractiveDelta(
  sql: ThreadControlStorage["sql"],
  binding: ThreadBinding,
  delta: InteractiveUsage,
): { exceeded: boolean; message: string; delta: InteractiveUsage } {
  const next = sql.transactionSync(() => {
    const current = interactiveUsage(sql);
    const value = {
      steps: current.steps + delta.steps,
      toolCalls: current.toolCalls + delta.toolCalls,
      tokens: current.tokens + delta.tokens,
      costUsd: current.costUsd + delta.costUsd,
      sandboxSeconds: current.sandboxSeconds + delta.sandboxSeconds,
      browserSeconds: current.browserSeconds + delta.browserSeconds,
    };
    put(sql, "interactiveUsage", value);
    return value;
  });
  return interactiveLimitResult(binding, next, delta);
}

function interactiveLimitResult(
  binding: ThreadBinding,
  next: InteractiveUsage,
  delta: InteractiveUsage,
): { exceeded: boolean; message: string; delta: InteractiveUsage } {
  const limits = objectValue(binding.metadata?.flaryLimits);
  const maxSteps = positive(limits.steps, Number.MAX_SAFE_INTEGER);
  const maxToolCalls = positive(limits.toolCalls, Number.MAX_SAFE_INTEGER);
  const maxTokens = positive(limits.tokens, Number.MAX_SAFE_INTEGER);
  const maxCost = positiveNumber(limits.costUsd, Number.MAX_VALUE);
  const maxSandbox = positive(limits.sandboxSeconds, Number.MAX_SAFE_INTEGER);
  const maxBrowser = positive(limits.browserSeconds, Number.MAX_SAFE_INTEGER);
  if (next.steps > maxSteps) {
    return {
      exceeded: true,
      message: `The interactive step limit of ${maxSteps} was exceeded`,
      delta,
    };
  }
  if (next.toolCalls > maxToolCalls) {
    return { exceeded: true, message: `The interactive tool-call limit of ${maxToolCalls} was exceeded`, delta };
  }
  if (next.tokens > maxTokens) {
    return { exceeded: true, message: `The interactive token limit of ${maxTokens} was exceeded`, delta };
  }
  if (next.costUsd > maxCost) {
    return {
      exceeded: true,
      message: `The interactive cost limit of ${maxCost} USD was exceeded`,
      delta,
    };
  }
  if (next.sandboxSeconds > maxSandbox) {
    return { exceeded: true, message: `The interactive Sandbox limit of ${maxSandbox} seconds was exceeded`, delta };
  }
  if (next.browserSeconds > maxBrowser) {
    return { exceeded: true, message: `The interactive browser limit of ${maxBrowser} seconds was exceeded`, delta };
  }
  return { exceeded: false, message: "", delta };
}

async function rootInteractiveReservationAction(
  sql: ThreadControlStorage["sql"],
  env: Record<string, unknown> | undefined,
  binding: ThreadBinding,
  method: "reserveUsage" | "settleUsage" | "unknownUsage",
  body: Record<string, unknown>,
): Promise<unknown> {
  const rootThreadId = binding.metadata?.flarySubagentRootThreadId;
  if (
    typeof rootThreadId === "string" &&
    rootThreadId !== binding.thread.threadId
  ) {
    const namespace = env?.FLARY_THREAD_CONTROL as
      | DurableObjectNamespace
      | undefined;
    if (!namespace) {
      throw new Error("Root usage reservations need FLARY_THREAD_CONTROL");
    }
    const name =
      `thread:${binding.thread.organizationId}:${binding.thread.appId}:${rootThreadId}`;
    const response = await namespace.get(namespace.idFromName(name)).fetch(
      new Request("https://flary.internal/usage-reservation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...body,
          method,
          tenantId: binding.thread.organizationId,
          applicationId: binding.thread.appId,
        }),
      }),
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        typeof objectValue(result).error === "string"
          ? String(objectValue(result).error)
          : "Root usage reservation failed",
      );
    }
    return result;
  }
  const reservationId = String(body.reservationId ?? "");
  if (!reservationId) throw new Error("A usage reservation ID is required");
  if (method === "reserveUsage") {
    return reserveInteractiveUsage(sql, binding, {
      reservationId,
      kind: String(body.kind ?? "runtime"),
      delta: usageValue(body.delta),
    });
  }
  if (method === "settleUsage") {
    return settleInteractiveUsage(
      sql,
      binding,
      reservationId,
      body.actual === undefined ? undefined : usageValue(body.actual),
    );
  }
  return markInteractiveUsageUnknown(sql, reservationId);
}

async function reserveRootInteractiveUsage(
  sql: ThreadControlStorage["sql"],
  env: Record<string, unknown> | undefined,
  binding: ThreadBinding,
  input: {
    readonly reservationId: string;
    readonly kind: string;
    readonly delta: InteractiveUsage;
  },
): Promise<unknown> {
  return rootInteractiveReservationAction(sql, env, binding, "reserveUsage", {
    reservationId: input.reservationId,
    kind: input.kind,
    delta: input.delta,
  });
}

function reserveInteractiveUsage(
  sql: ThreadControlStorage["sql"],
  binding: ThreadBinding,
  input: {
    readonly reservationId: string;
    readonly kind: string;
    readonly delta: InteractiveUsage;
  },
): { reserved: true; replay: boolean; usage: InteractiveUsage } {
  return sql.transactionSync(() => {
    const existing = sql.exec<{ state: string; reserved_json: string }>(
      `SELECT state, reserved_json FROM flary_interactive_reservations
       WHERE reservation_id = ?`,
      input.reservationId,
    ).toArray()[0];
    if (existing) {
      const stored = usageValue(JSON.parse(existing.reserved_json));
      if (JSON.stringify(stored) !== JSON.stringify(input.delta)) {
        throw new Error("A usage reservation changed during replay");
      }
      return { reserved: true as const, replay: true, usage: interactiveUsage(sql) };
    }
    const current = interactiveUsage(sql);
    const held = reservedInteractiveUsage(sql);
    const projected = addUsage(addUsage(current, held), input.delta);
    const limit = interactiveLimitResult(binding, projected, input.delta);
    if (limit.exceeded) throw new Error(limit.message);
    const now = new Date().toISOString();
    sql.exec(
      `INSERT INTO flary_interactive_reservations
        (reservation_id, kind, state, reserved_json, actual_json, created_at, updated_at)
       VALUES (?, ?, 'held', ?, NULL, ?, ?)`,
      input.reservationId,
      input.kind.slice(0, 100),
      JSON.stringify(input.delta),
      now,
      now,
    );
    return { reserved: true as const, replay: false, usage: projected };
  });
}

function settleInteractiveUsage(
  sql: ThreadControlStorage["sql"],
  binding: ThreadBinding,
  reservationId: string,
  actual?: InteractiveUsage,
): { settled: true; replay: boolean; usage: InteractiveUsage } {
  return sql.transactionSync(() => {
    const row = sql.exec<{
      state: string;
      reserved_json: string;
      actual_json: string | null;
    }>(
      `SELECT state, reserved_json, actual_json
       FROM flary_interactive_reservations WHERE reservation_id = ?`,
      reservationId,
    ).toArray()[0];
    if (!row) throw new Error("The usage reservation was not found");
    if (row.state === "unknown") {
      throw new Error("An unknown usage outcome needs operator resolution");
    }
    if (row.state === "settled") {
      return { settled: true as const, replay: true, usage: interactiveUsage(sql) };
    }
    const applied = actual ?? usageValue(JSON.parse(row.reserved_json));
    const next = addUsage(interactiveUsage(sql), applied);
    const limit = interactiveLimitResult(binding, next, applied);
    if (limit.exceeded) throw new Error(limit.message);
    put(sql, "interactiveUsage", next);
    sql.exec(
      `UPDATE flary_interactive_reservations
       SET state = 'settled', actual_json = ?, updated_at = ?
       WHERE reservation_id = ? AND state = 'held'`,
      JSON.stringify(applied),
      new Date().toISOString(),
      reservationId,
    );
    return { settled: true as const, replay: false, usage: next };
  });
}

function markInteractiveUsageUnknown(
  sql: ThreadControlStorage["sql"],
  reservationId: string,
): { unknown: true } {
  sql.exec(
    `UPDATE flary_interactive_reservations
     SET state = 'unknown', updated_at = ?
     WHERE reservation_id = ? AND state = 'held'`,
    new Date().toISOString(),
    reservationId,
  );
  return { unknown: true };
}

function reservedInteractiveUsage(
  sql: ThreadControlStorage["sql"],
): InteractiveUsage {
  return sql.exec<{ reserved_json: string }>(
    `SELECT reserved_json FROM flary_interactive_reservations
     WHERE state IN ('held', 'unknown')`,
  ).toArray().reduce(
    (sum, row) => addUsage(sum, usageValue(JSON.parse(row.reserved_json))),
    emptyUsage(),
  );
}

function usageValue(value: unknown): InteractiveUsage {
  const input = objectValue(value);
  return {
    steps: nonnegative(input.steps, 0),
    toolCalls: nonnegative(input.toolCalls, 0),
    tokens: nonnegative(input.tokens, 0),
    costUsd: positiveNumber(input.costUsd, 0),
    sandboxSeconds: nonnegative(input.sandboxSeconds, 0),
    browserSeconds: nonnegative(input.browserSeconds, 0),
  };
}

function emptyUsage(input: Partial<InteractiveUsage> = {}): InteractiveUsage {
  return {
    steps: input.steps ?? 0,
    toolCalls: input.toolCalls ?? 0,
    tokens: input.tokens ?? 0,
    costUsd: input.costUsd ?? 0,
    sandboxSeconds: input.sandboxSeconds ?? 0,
    browserSeconds: input.browserSeconds ?? 0,
  };
}

function addUsage(left: InteractiveUsage, right: InteractiveUsage): InteractiveUsage {
  return {
    steps: left.steps + right.steps,
    toolCalls: left.toolCalls + right.toolCalls,
    tokens: left.tokens + right.tokens,
    costUsd: left.costUsd + right.costUsd,
    sandboxSeconds: left.sandboxSeconds + right.sandboxSeconds,
    browserSeconds: left.browserSeconds + right.browserSeconds,
  };
}

async function accountRootInteractiveEvent(
  env: Record<string, unknown>,
  binding: ThreadBinding,
  delta: InteractiveUsage,
): Promise<{ exceeded: boolean; message: string }> {
  const rootThreadId = binding.metadata?.flarySubagentRootThreadId;
  if (typeof rootThreadId !== "string") {
    return { exceeded: false, message: "" };
  }
  if (Object.values(delta).every((value) => value === 0)) {
    return { exceeded: false, message: "" };
  }
  const namespace = env.FLARY_THREAD_CONTROL as DurableObjectNamespace | undefined;
  if (!namespace) return { exceeded: false, message: "" };
  const name =
    `thread:${binding.thread.organizationId}:${binding.thread.appId}:${rootThreadId}`;
  const response = await namespace.get(namespace.idFromName(name)).fetch(
    new Request("https://flary.internal/accountUsage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "accountUsage",
        tenantId: binding.thread.organizationId,
        applicationId: binding.thread.appId,
        delta,
      }),
    }),
  );
  const value = objectValue(await response.json().catch(() => ({})));
  if (!response.ok) throw new Error("Root usage accounting failed");
  return {
    exceeded: value.exceeded === true,
    message: typeof value.message === "string" ? value.message : "",
  };
}

interface InteractiveUsage {
  steps: number;
  toolCalls: number;
  tokens: number;
  costUsd: number;
  sandboxSeconds: number;
  browserSeconds: number;
}

function interactiveUsage(sql: ThreadControlStorage["sql"]): InteractiveUsage {
  const row = sql.exec<{ value_json: string }>(
    "SELECT value_json FROM flary_thread_control WHERE key = 'interactiveUsage'",
  ).toArray()[0];
  const value = row ? objectValue(JSON.parse(row.value_json)) : {};
  return {
    steps: nonnegative(value.steps, 0),
    toolCalls: nonnegative(value.toolCalls, 0),
    tokens: nonnegative(value.tokens, 0),
    costUsd:
      typeof value.costUsd === "number" && Number.isFinite(value.costUsd)
        ? value.costUsd
        : 0,
    sandboxSeconds: nonnegative(value.sandboxSeconds, 0),
    browserSeconds: nonnegative(value.browserSeconds, 0),
  };
}

function canonicalEventCursor(
  submissionId: string,
  event: Record<string, unknown>,
): string {
  const position = objectValue(event.position);
  if (
    typeof position.batch === "number" &&
    typeof position.index === "number"
  ) {
    return `flue:${submissionId}:${position.batch}:${position.index}`;
  }
  const offset =
    typeof event.offset === "string" || typeof event.offset === "number"
      ? String(event.offset)
      : JSON.stringify(event);
  return `flue:${submissionId}:${offset}`;
}

function initializeSubagents(
  sql: ThreadControlStorage["sql"],
  binding: ThreadBinding,
): SqliteSubagentCoordinator {
  const delegation = objectValue(binding.metadata?.flaryDelegation);
  return new SqliteSubagentCoordinator({
    sql,
    sessionId: binding.thread.threadId,
    rootThread: {
      threadId: binding.thread.threadId,
      sessionId: binding.thread.threadId,
      rootThreadId: binding.thread.threadId,
      agentId: binding.agentId,
      role: "default",
      mode: binding.defaultMode,
      agentPath: `/${binding.agentId}`,
      depth: 0,
      status: "running",
      task: "Root interactive thread",
      contextSeed: {
        turns: 0,
        includeSystem: true,
        includeArtifacts: true,
      },
      seededTurnIds: [],
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
    },
    policy: {
      mode:
        delegation.mode === "disabled" ||
        delegation.mode === "auto" ||
        delegation.mode === "explicit"
          ? delegation.mode
          : "explicit",
      maxConcurrentChildren: positive(delegation.maxConcurrentChildren, 4),
      maxTotalChildren: positive(delegation.maxTotalChildren, 16),
      maxDepth: nonnegative(delegation.maxDepth, 2),
      allowPeerMessaging: delegation.allowPeerMessaging === true,
    },
  });
}

function subagentAction(
  sql: ThreadControlStorage["sql"],
  binding: ThreadBinding,
  action: string,
  input: Record<string, unknown>,
): unknown {
  const coordinator = initializeSubagents(sql, binding);
  const sessionId = binding.thread.threadId;
  if (action === "list") {
    const currentThreadId = typeof input.currentThreadId === "string"
      ? input.currentThreadId
      : binding.thread.threadId;
    return {
      threads: coordinator.listThreads(),
      messages: coordinator.readMessages(
        currentThreadId,
        numericValue(input.afterSequence, 0),
      ),
      activity: coordinator.readActivity(numericValue(input.afterSequence, 0)),
    };
  }
  if (action === "turn") {
    return { turn: coordinator.appendTurn(input.turn as never) };
  }
  if (action === "spawn") {
    return {
      thread: coordinator.spawn({
        ...input,
        requestId: stringOrId(input.requestId),
        sessionId,
        parentThreadId:
          typeof input.parentThreadId === "string"
            ? input.parentThreadId
            : binding.thread.threadId,
        agentId:
          typeof input.agentId === "string" ? input.agentId : binding.agentId,
        task: typeof input.task === "string" ? input.task : "Complete the delegated task.",
        seedTurns: numericValue(input.seedTurns, 0),
      }),
    };
  }
  if (action === "send") {
    const toThreadId = String(input.toThreadId ?? input.threadId ?? "");
    const message = coordinator.send({
      ...input,
      requestId: stringOrId(input.requestId),
      sessionId,
      fromThreadId:
        typeof input.fromThreadId === "string"
          ? input.fromThreadId
          : binding.thread.threadId,
      toThreadId,
      content: typeof input.content === "string" ? input.content : "",
    });
    return { message, thread: coordinator.getThread(toThreadId) };
  }
  if (action === "wait" && Array.isArray(input.threadIds)) {
    const ids = Array.isArray(input.threadIds)
      ? input.threadIds.map(String)
      : [];
    return {
      threads: ids.map((id) => coordinator.getThread(id)).filter(Boolean),
      messages: typeof input.currentThreadId === "string"
        ? coordinator.readMessages(
            input.currentThreadId,
            numericValue(input.afterSequence, 0),
          )
        : [],
      activity: coordinator.readActivity(numericValue(input.afterSequence, 0)),
    };
  }
  const threadId = String(input.threadId ?? "");
  const controlAction =
    action === "interrupt"
      ? "cancel"
      : action === "close" ||
          action === "resume" ||
          action === "start" ||
          action === "wait" ||
          action === "complete" ||
          action === "fail" ||
          action === "cancel" ||
          action === "handoff"
        ? action
        : undefined;
  if (!controlAction) throw new Error(`Unknown subagent action '${action}'`);
  return {
    thread: coordinator.control({
      requestId: stringOrId(input.requestId),
      sessionId,
      threadId,
      action: controlAction,
      ...(input.output !== undefined
        ? { output: jsonValue(input.output) as never }
        : {}),
      ...(input.error !== undefined ? { error: input.error as never } : {}),
      ...(typeof input.targetThreadId === "string"
        ? { targetThreadId: input.targetThreadId }
        : {}),
      reason: typeof input.reason === "string" ? input.reason : undefined,
      idempotencyKey:
        typeof input.idempotencyKey === "string"
          ? input.idempotencyKey
          : undefined,
    }),
  };
}

async function appendLedger(
  sql: ThreadControlStorage["sql"],
  binding: ThreadBinding,
  recordType: SessionRecordType,
  payload: Record<string, unknown>,
  options: { readonly producer?: SessionRecord["producer"] } = {},
) {
  const ledger = new SqliteSessionLedger(sql);
  return ledger.append({
    tenantId: binding.thread.organizationId,
    applicationId: binding.thread.appId,
    sessionId: binding.thread.threadId,
    threadId: binding.thread.threadId,
    agentId: binding.agentId,
    sourceCursor:
      `control:${Date.now()}:${crypto.randomUUID().replaceAll("-", "")}`,
    recordType,
    recordedAt: new Date().toISOString(),
    attempt: 0,
    sourceRevision:
      typeof binding.metadata?.flaryAgentRevision === "string"
        ? binding.metadata.flaryAgentRevision
        : "flary-thread-control-v1",
    ...(options.producer ? { producer: options.producer } : {}),
    publicPayload: JSON.parse(JSON.stringify(payload)),
  });
}

function safeProducer(
  value: Record<string, unknown>,
): SessionRecord["producer"] | undefined {
  const producer = value.producer;
  if (!producer || typeof producer !== "object" || Array.isArray(producer)) {
    return undefined;
  }
  const candidate = producer as Record<string, unknown>;
  if (typeof candidate.provider !== "string" || typeof candidate.model !== "string") {
    return undefined;
  }
  return {
    provider: candidate.provider,
    model: candidate.model,
    ...(typeof candidate.variant === "string" ? { variant: candidate.variant } : {}),
  };
}

async function readLedger(
  sql: ThreadControlStorage["sql"],
  sessionId: string,
  after: number,
  limit: number,
  env?: Record<string, unknown>,
) {
  const ledger = new SqliteSessionLedger(sql);
  const records = [];
  const bucket = env?.FLARY_SESSION_ARCHIVE as
    | SessionArchiveBucket
    | undefined;
  const secret =
    typeof env?.FLARY_SESSION_ARCHIVE_KEY === "string"
      ? env.FLARY_SESSION_ARCHIVE_KEY
      : undefined;
  if (bucket && secret) {
    records.push(
      ...await new R2SessionArchive({ sql, bucket, secret }).read(sessionId, {
        after,
        limit,
      }),
    );
  }
  let cursor = after > 0 ? `v1:${after}` : undefined;
  let remaining = limit - records.length;
  while (remaining > 0) {
    const page = await ledger.list(sessionId, {
      ...(cursor ? { after: cursor } : {}),
      limit: Math.min(remaining, 1_000),
    });
    records.push(...page.items);
    remaining -= page.items.length;
    if (!page.nextCursor || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  return records;
}

async function sealSessionArchiveIfNeeded(
  sql: ThreadControlStorage["sql"],
  env: Record<string, unknown>,
  sessionId: string,
): Promise<void> {
  const bucket = env.FLARY_SESSION_ARCHIVE as SessionArchiveBucket | undefined;
  const secret =
    typeof env.FLARY_SESSION_ARCHIVE_KEY === "string"
      ? env.FLARY_SESSION_ARCHIVE_KEY
      : undefined;
  if (!bucket || !secret) return;
  await new R2SessionArchive({ sql, bucket, secret }).sealColdRecords(sessionId);
}

function canonicalArchiveFor(
  sql: ThreadControlStorage["sql"],
  env: Record<string, unknown> | undefined,
): SqliteCanonicalSessionArchive | undefined {
  const bucket = env?.FLARY_SESSION_ARCHIVE as SessionArchiveBucket | undefined;
  const secret = typeof env?.FLARY_SESSION_ARCHIVE_KEY === "string"
    ? env.FLARY_SESSION_ARCHIVE_KEY
    : undefined;
  if (!bucket || !secret) return undefined;
  return new SqliteCanonicalSessionArchive({ sql, bucket, secret });
}

/** Capture the provider-neutral Flue projection in encrypted R2. */
async function captureCanonicalSnapshot(
  input: {
    readonly sql: ThreadControlStorage["sql"];
    readonly env: Record<string, unknown>;
    readonly binding: ThreadBinding;
    readonly admission: FlueAdmission;
    readonly modelPin?: ResolvedModelPin;
    readonly segmentId?: string;
  },
  gateway: FlueAgentGateway,
): Promise<void> {
  const archive = canonicalArchiveFor(
    input.sql,
    input.env,
  );
  if (!archive || !gateway.history) return;
  const snapshot = await gateway.history(
    runtimeAgentId(input.binding),
    threadName(input.binding.thread),
  );
  await archive.append(
    input.binding.thread.threadId,
    JSON.stringify({
      format: "flary-canonical-flue-snapshot",
      version: 1,
      sessionId: input.binding.thread.threadId,
      submissionId: input.admission.submissionId,
      capturedAt: new Date().toISOString(),
      ...(input.segmentId ? { segmentId: input.segmentId } : {}),
      ...(input.modelPin ? { modelPin: input.modelPin } : {}),
      snapshot,
    }),
  );
}

function requireBinding(sql: ThreadControlStorage["sql"]): ThreadBinding {
  const row = sql.exec<{ value_json: string }>(
    "SELECT value_json FROM flary_thread_control WHERE key = 'binding'",
  ).toArray()[0];
  if (!row) throw new Error("The thread was not found");
  return ThreadBindingSchema.parse(JSON.parse(row.value_json));
}

/** The generated root Flue class also serves declared durable child threads. */
function runtimeAgentId(binding: ThreadBinding): string {
  return typeof binding.metadata?.flaryRuntimeAgentId === "string"
    ? binding.metadata.flaryRuntimeAgentId
    : binding.agentId;
}

interface StoredModelPolicy {
  readonly allow: ModelSelection[];
  readonly switching: "user" | "disabled";
  readonly fallback: "none";
}

function modelPolicy(binding: ThreadBinding): StoredModelPolicy {
  const value = binding.metadata?.flaryModelPolicy;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { allow: binding.defaultModel ? [binding.defaultModel] : [], switching: "user", fallback: "none" };
  }
  const candidate = value as Record<string, unknown>;
  const allow = Array.isArray(candidate.allow)
    ? candidate.allow.flatMap((item) => {
        const parsed = ModelSelectionSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  return {
    allow,
    switching: candidate.switching === "disabled" ? "disabled" : "user",
    fallback: "none",
  };
}

interface ForkBoundary {
  readonly records: Record<string, unknown>[];
  readonly turnId?: string;
  readonly checkpointId?: string;
}

function resolveForkBoundary(
  records: readonly Record<string, unknown>[],
  requestedTurnId?: string,
): ForkBoundary {
  const completed = records.filter((record) =>
    record.recordType === "turn.completed" && recordTurnId(record),
  );
  const latest = completed.at(-1);
  const selected = requestedTurnId
    ? completed.find((record) => recordTurnId(record) === requestedTurnId)
    : latest;
  if (!selected) {
    if (!requestedTurnId) return { records: [...records] };
    throw new FlaryHostError(
      409,
      "fork_turn_incomplete",
      requestedTurnId
        ? `The fork turn '${requestedTurnId}' is not a completed turn`
        : "The thread has no completed turn to fork",
      { latestCompletedTurnId: latest ? recordTurnId(latest) : undefined },
    );
  }
  const turnId = recordTurnId(selected)!;
  const completionIndex = records.indexOf(selected);
  const sourceCursor = typeof selected.sourceCursor === "string"
    ? selected.sourceCursor
    : "";
  const submissionId = sourceCursor.startsWith("flue:")
    ? sourceCursor.slice(5).split(":", 1)[0]
    : undefined;
  let endIndex = completionIndex;
  let checkpointId: string | undefined;
  for (let index = completionIndex + 1; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.recordType === "turn.started" && recordTurnId(record) !== turnId) {
      break;
    }
    const payload = objectValue(record.publicPayload);
    if (
      record.recordType === "artifact.checkpoint" &&
      (!submissionId || payload.submissionId === submissionId)
    ) {
      const checkpoint = objectValue(payload.checkpoint);
      const commit = objectValue(checkpoint.commit);
      if (typeof commit.id === "string") checkpointId = commit.id;
      endIndex = index;
    } else if (record.recordType !== "provider.segment.started") {
      endIndex = index;
    }
  }
  return {
    records: records.slice(0, endIndex + 1),
    turnId,
    ...(checkpointId ? { checkpointId } : {}),
  };
}

function recordTurnId(record: Record<string, unknown>): string | undefined {
  if (typeof record.turnId === "string") return record.turnId;
  const payload = objectValue(record.publicPayload);
  return typeof payload.turnId === "string"
    ? payload.turnId
    : typeof payload.messageId === "string"
      ? payload.messageId
      : undefined;
}

function forkWorkspaceBranch(parent: string, threadId: string): string {
  const suffix = threadId.replace(/[^A-Za-z0-9_-]/g, "-").slice(-48);
  return `${parent.slice(0, Math.max(1, 200 - suffix.length - 6))}-fork-${suffix}`;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Json(value: unknown): Promise<string> {
  return sha256Text(JSON.stringify(value));
}

async function portableArchiveHash(
  archive: ThreadPortableArchive,
): Promise<string> {
  const { sha256: _sha256, ...unsigned } = archive;
  return sha256Json(unsigned);
}

function currentModel(
  sql: ThreadControlStorage["sql"],
  binding: ThreadBinding,
): ModelSelection | undefined {
  const row = sql.exec<{ value_json: string }>(
    "SELECT value_json FROM flary_thread_control WHERE key = 'model-state'",
  ).toArray()[0];
  if (row) {
    const parsed = ModelSelectionSchema.safeParse(JSON.parse(row.value_json));
    if (parsed.success) return parsed.data;
  }
  return binding.defaultModel;
}

function sameModel(left: ModelSelection, right: ModelSelection): boolean {
  return left.provider === right.provider &&
    left.model === right.model &&
    left.deployment === right.deployment &&
    left.variant === right.variant;
}

function assertAllowedModel(binding: ThreadBinding, selection: ModelSelection): void {
  const policy = modelPolicy(binding);
  if (policy.allow.length === 0) return;
  if (!policy.allow.some((allowed) => sameModel(allowed, selection))) {
    throw new Error(`The model '${toFlueModelSpecifier(selection)}' is not allowed for this agent`);
  }
}

function nextControlSequence(sql: ThreadControlStorage["sql"], prefix: string): number {
  const rows = sql.exec<{ key: string }>(
    "SELECT key FROM flary_thread_control WHERE key LIKE ? ORDER BY key DESC LIMIT 1",
    `${prefix}%`,
  ).toArray();
  const value = rows[0]?.key.slice(prefix.length);
  const parsed = value ? Number(value) : 0;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed + 1 : 1;
}

function resolvedModelPin(
  binding: ThreadBinding,
  selection: ModelSelection,
): ResolvedModelPin {
  const metadata = binding.metadata ?? {};
  const grants = binding.connectionIds;
  const credentialGeneration = typeof metadata.credentialGeneration === "string"
    ? metadata.credentialGeneration
    : undefined;
  return {
    selection,
    provider: selection.provider,
    model: selection.model,
    ...(selection.deployment ? { deployment: selection.deployment } : {}),
    ...(selection.variant ? { variant: selection.variant } : {}),
    ...(selection.reasoningEffort ? { reasoning: selection.reasoningEffort } : {}),
    capabilitySnapshot: [...(selection.capabilities ?? [])],
    ...(typeof metadata.modelCatalogRevision === "string"
      ? { modelCatalogRevision: metadata.modelCatalogRevision }
      : {}),
    ...(typeof metadata.adapterRevision === "string"
      ? { adapterRevision: metadata.adapterRevision }
      : {}),
    ...(grants[0] ? { connectionReference: grants[0] } : {}),
    ...(credentialGeneration ? { credentialGeneration } : {}),
    cachePolicy: selection.cacheRetention ?? "short",
  };
}

function assertOwner(
  sql: ThreadControlStorage["sql"],
  body: Record<string, unknown>,
  initialize = false,
): void {
  const row = sql.exec<{ value_json: string }>(
    "SELECT value_json FROM flary_thread_control WHERE key = 'owner'",
  ).toArray()[0];
  if (!row) {
    if (initialize) {
      put(sql, "owner", {
        tenantId: body.tenantId,
        applicationId: body.applicationId,
      });
      return;
    }
    throw new Error("The thread was not found");
  }
  const owner = JSON.parse(row.value_json) as Record<string, unknown>;
  if (
    owner.tenantId !== body.tenantId ||
    owner.applicationId !== body.applicationId
  ) {
    throw new Error("The thread does not belong to this tenant");
  }
}

function put(
  sql: ThreadControlStorage["sql"],
  key: string,
  value: unknown,
): void {
  sql.exec(
    `INSERT INTO flary_thread_control (key, value_json)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    key,
    JSON.stringify(value),
  );
}

async function agentApprovalRpc(
  env: Record<string, unknown>,
  binding: ThreadBinding,
  action: "approvals" | "approval",
  decision?: ApprovalDecision,
): Promise<any> {
  const fetcher = createCloudflareFlueFetch(env);
  const headers = new Headers({ "content-type": "application/json" });
  if (typeof env.FLARY_INTERNAL_TOKEN === "string") {
    headers.set("authorization", `Bearer ${env.FLARY_INTERNAL_TOKEN}`);
  }
  const instanceId = threadName(binding.thread);
  const response = await fetcher(
    `https://flue.internal/agents/${encodeURIComponent(runtimeAgentId(binding))}/${encodeURIComponent(instanceId)}?flary=${action}`,
    {
      method: action === "approval" ? "POST" : "GET",
      headers,
      ...(decision ? { body: JSON.stringify(decision) } : {}),
    },
  );
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Agent approval request failed (${response.status})`);
  return value;
}

async function agentControlRpc(
  env: Record<string, unknown>,
  binding: ThreadBinding,
  action: "compact" | "rollback" | "export" | "import",
  input: unknown,
): Promise<unknown> {
  const agentId = runtimeAgentId(binding);
  const namespace = env[
    `FLUE_AGENT_${agentId.replaceAll(/[^A-Za-z0-9]/g, "_").toUpperCase()}`
  ] as DurableObjectNamespace | undefined;
  if (!namespace) {
    return { runtimeUnavailable: true };
  }
  const instanceId = threadName(binding.thread);
  const token =
    typeof env.FLARY_INTERNAL_TOKEN === "string"
      ? env.FLARY_INTERNAL_TOKEN
      : undefined;
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await namespace
    .get(namespace.idFromName(instanceId))
    .fetch(
      new Request(
        `https://flue.internal/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(instanceId)}?flary=${action}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(input ?? {}),
        },
      ),
    );
  const value = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(
      value && typeof value === "object" && "error" in value
        ? String((value as { error: unknown }).error)
        : `Flue ${action} failed (${response.status})`,
    );
  }
  return value;
}

async function projectAgentSnapshot(
  env: Record<string, unknown>,
  binding: ThreadBinding,
  project: (
    event: Record<string, unknown>,
    sourceCursor: string,
  ) => Promise<unknown>,
): Promise<void> {
  const agentId = runtimeAgentId(binding);
  const namespace = env[
    `FLUE_AGENT_${agentId.replaceAll(/[^A-Za-z0-9]/g, "_").toUpperCase()}`
  ] as DurableObjectNamespace | undefined;
  if (!namespace) return;
  const instanceId = threadName(binding.thread);
  const fetcher = createCloudflareFlueFetch(env);
  const response = await fetcher(
    `https://flue.internal/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(instanceId)}?view=history`,
    { method: "GET" },
  );
  if (!response.ok) {
    throw new Error(`Flue conversation snapshot failed (${response.status})`);
  }
  const snapshot = objectValue(await response.json());
  const offset = String(snapshot.offset ?? "");
  await project(
    {
      type: "conversation-reset",
      conversationId: snapshot.conversationId,
      snapshot,
      timestamp: new Date().toISOString(),
    },
    `flue:control:${agentId}:${instanceId}:${offset}`,
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function subagentWaitSettled(value: unknown): boolean {
  const threads = objectValue(value).threads;
  return Array.isArray(threads) && threads.length > 0 && threads.every((thread) => {
    const status = objectValue(thread).status;
    return status === "completed" || status === "failed" ||
      status === "cancelled" || status === "closed";
  });
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function nonnegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

function numericValue(value: unknown, fallback: number): number {
  return nonnegative(value, fallback);
}

function stringOrId(value: unknown): string {
  return typeof value === "string" && value.length > 0
    ? value
    : `request_${crypto.randomUUID().replaceAll("-", "")}`;
}
