import { z } from "zod";

import {
  ApprovalDecisionSchema,
  type ApprovalDecision,
} from "../contracts/approvals.js";
import {
  IdentityReferenceSchema,
  type IdentityReference,
} from "../contracts/identity.js";
import {
  RecallDocumentSchema,
  RecallSearchResponseSchema,
  type RecallDocument,
  type RecallSearchResponse,
} from "../contracts/recall.js";
import {
  ThreadBindingSchema,
  ThreadCreateRequestSchema,
  ThreadCompactRequestSchema,
  ThreadForkRequestSchema,
  ThreadGoalRequestSchema,
  ThreadHistoryDiffResponseSchema,
  ThreadHistoryListResponseSchema,
  ThreadPinRequestSchema,
  ThreadReadRequestSchema,
  ThreadRecordListRequestSchema,
  ThreadRenameRequestSchema,
  ThreadRollbackRequestSchema,
  ThreadRestoreRequestSchema,
  ThreadMessageRequestSchema,
  ThreadModelSetRequestSchema,
  type ThreadBinding,
  type ThreadDeletion,
  type ThreadCreateRequest,
  type ThreadForkRequest,
  type ThreadHistoryDiffResponse,
  type ThreadHistoryListResponse,
  type ThreadCompactRequest,
  type ThreadGoalRequest,
  type ThreadPinRequest,
  type ThreadReadRequest,
  type ThreadRecordListRequest,
  type ThreadRenameRequest,
  type ThreadRollbackRequest,
  type ThreadPortableArchive,
  type ThreadMessageRequest,
  type ThreadModelSetRequest,
  type ThreadRestoreRequest,
} from "../contracts/threads.js";
import {
  UserInputAnswerRequestSchema,
  UserInputRecordSchema,
  type UserInputAnswerRequest,
  type UserInputRecord,
} from "../contracts/user-input.js";
import { ThreadOperationalStateSchema } from "../contracts/runtime.js";
import type {
  RealtimeTicketRequest,
  RealtimeTicketResponse,
} from "../contracts/realtime.js";
import { ThreadRefSchema, type ThreadRef } from "../contracts/tenancy.js";
import { AgentModeIdSchema, type AgentModeId } from "../contracts/modes.js";
import type {
  ProviderCredentialLifecycle,
  ProviderEncryptedCredentialHandoff,
  ProviderOAuthCompleteInput,
  ProviderOAuthSession,
  ProviderOAuthStartInput,
} from "../contracts/connections.js";

export const FlaryHostAuthorizationSchema = z
  .object({
    organizationId: z.string().min(1),
    actor: IdentityReferenceSchema,
  })
  .strict();
export type FlaryHostAuthorization = z.infer<
  typeof FlaryHostAuthorizationSchema
>;

export const FlaryThreadAdmissionSchema = z
  .object({
    streamUrl: z.string().min(1),
    offset: z.string(),
    submissionId: z.string().min(1),
    duplicate: z.boolean().optional(),
  })
  .strict();
export type FlaryThreadAdmission = z.infer<
  typeof FlaryThreadAdmissionSchema
>;

export const FlaryRecallSearchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(100_000),
    mode: z.enum(["exact", "semantic", "hybrid"]).default("hybrid"),
    kinds: z
      .array(
        z.enum([
          "message",
          "plan",
          "decision",
          "file",
          "tool",
          "run",
          "event",
        ]),
      )
      .max(7)
      .optional(),
    limit: z.coerce.number().int().positive().max(100).default(10),
  })
  .strict();
export type FlaryRecallSearchRequest = z.infer<
  typeof FlaryRecallSearchRequestSchema
>;

export const FlaryRecallOpenRequestSchema = z
  .object({
    id: z.string().min(1).optional(),
    reference: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.id) !== Boolean(value.reference), {
    message: "Provide exactly one recall id or reference",
  });
export type FlaryRecallOpenRequest = z.infer<
  typeof FlaryRecallOpenRequestSchema
>;

export interface FlaryHostRequest<TBindings> {
  readonly request: Request;
  readonly env: TBindings;
  readonly appId: string;
}

export type ResolveFlaryHostAuthorization<TBindings> = (
  input: FlaryHostRequest<TBindings>,
) => Promise<FlaryHostAuthorization> | FlaryHostAuthorization;

export interface FlaryThreadScope {
  readonly authorization: FlaryHostAuthorization;
  readonly appId: string;
}

export interface FlaryThreadTarget extends FlaryThreadScope {
  readonly threadId: string;
}

/** Product-owned storage adapter for user-scoped provider OAuth sessions. */
export interface FlaryProviderOAuthHostService {
  start(
    scope: FlaryThreadScope,
    input: ProviderOAuthStartInput,
  ): Promise<ProviderOAuthSession>;
  inspect(
    scope: FlaryThreadScope,
    sessionId: string,
    options: { poll: boolean },
  ): Promise<ProviderOAuthSession>;
  complete(
    scope: FlaryThreadScope,
    sessionId: string,
    input: ProviderOAuthCompleteInput,
  ): Promise<ProviderOAuthSession>;
  cancel(
    scope: FlaryThreadScope,
    sessionId: string,
  ): Promise<ProviderOAuthSession>;
  importEncrypted(
    scope: FlaryThreadScope,
    input: ProviderEncryptedCredentialHandoff,
  ): Promise<ProviderCredentialLifecycle>;
  /** Remove the local credential. Remote provider revocation is optional. */
  disconnect(scope: FlaryThreadScope, connectionId: string): Promise<void>;
}

/**
 * Product-owned persistence and execution adapter for the open-source host.
 *
 * Flary validates the public protocol. The product supplies authentication,
 * tenant lookup, durable storage, provider credentials, and its agent tools.
 */
export interface FlaryThreadHostService {
  list(scope: FlaryThreadScope): Promise<ThreadBinding[]>;
  create(
    scope: FlaryThreadScope,
    input: z.output<typeof ThreadCreateRequestSchema>,
  ): Promise<ThreadBinding>;
  inspect(target: FlaryThreadTarget): Promise<ThreadBinding>;
  realtimeTicket?(
    target: FlaryThreadTarget,
    input: RealtimeTicketRequest,
    requestUrl: string,
  ): Promise<RealtimeTicketResponse>;
  realtimeConnect?(
    appId: string,
    threadId: string,
    ticket: string,
  ): Promise<Response>;
  terminalTicket?(
    target: FlaryThreadTarget,
    input: { readonly cols?: number; readonly rows?: number },
    requestUrl: string,
  ): Promise<{ readonly url: string; readonly expiresAt: string }>;
  terminalConnect?(
    target: FlaryThreadTarget,
    ticket: string,
    request: Request,
  ): Promise<Response>;
  archive(target: FlaryThreadTarget): Promise<ThreadBinding>;
  unarchive?(target: FlaryThreadTarget): Promise<ThreadBinding>;
  rename?(
    target: FlaryThreadTarget,
    input: ThreadRenameRequest,
  ): Promise<ThreadBinding>;
  pin?(
    target: FlaryThreadTarget,
    input: ThreadPinRequest,
  ): Promise<ThreadBinding>;
  markRead?(
    target: FlaryThreadTarget,
    input: ThreadReadRequest,
  ): Promise<ThreadBinding>;
  delete?(target: FlaryThreadTarget): Promise<ThreadDeletion>;
  deletion?(target: FlaryThreadTarget, deletionId: string): Promise<ThreadDeletion>;
  /** Internal queue consumer hook. It is not exposed as a public route. */
  purge?(target: FlaryThreadTarget, deletionId: string): Promise<void>;
  fork(
    target: FlaryThreadTarget,
    input: ThreadForkRequest,
  ): Promise<ThreadBinding>;
  setMode(
    target: FlaryThreadTarget,
    mode: AgentModeId,
    reason?: string,
  ): Promise<ThreadBinding>;
  setConnections(
    target: FlaryThreadTarget,
    connectionIds: string[],
  ): Promise<ThreadBinding>;
  modelGet?(target: FlaryThreadTarget): Promise<unknown>;
  modelList?(target: FlaryThreadTarget): Promise<readonly unknown[]>;
  modelSet?(
    target: FlaryThreadTarget,
    input: ThreadModelSetRequest,
  ): Promise<unknown>;
  modelHistory?(target: FlaryThreadTarget): Promise<readonly unknown[]>;
  submit(
    target: FlaryThreadTarget,
    input: ThreadMessageRequest,
  ): Promise<FlaryThreadAdmission>;
  /** Read the safe, provider-neutral conversation through tenant authorization. */
  conversation?(target: FlaryThreadTarget): Promise<unknown>;
  /** Stream the same safe conversation projection from a durable cursor. */
  conversationUpdates?(
    target: FlaryThreadTarget,
    input: {
      readonly offset: string;
      readonly live: "long-poll" | "sse";
      readonly signal?: AbortSignal;
    },
  ): Promise<Response>;
  /** Read one Flue attachment after the host resolves tenant ownership. */
  attachment?(
    target: FlaryThreadTarget,
    attachmentId: string,
    input: { readonly signal?: AbortSignal },
  ): Promise<Response>;
  edit?(
    target: FlaryThreadTarget,
    input: import("../contracts/threads.js").ThreadEditRequest,
  ): Promise<FlaryThreadAdmission>;
  interrupt?(target: FlaryThreadTarget): Promise<void>;
  compact?(
    target: FlaryThreadTarget,
    input: ThreadCompactRequest,
  ): Promise<unknown>;
  rollback?(
    target: FlaryThreadTarget,
    input: ThreadRollbackRequest,
  ): Promise<unknown>;
  restore?(
    target: FlaryThreadTarget,
    input: ThreadRestoreRequest,
  ): Promise<unknown>;
  exportSession?(target: FlaryThreadTarget): Promise<ThreadPortableArchive>;
  setGoal?(
    target: FlaryThreadTarget,
    input: ThreadGoalRequest,
  ): Promise<unknown>;
  clearGoal?(target: FlaryThreadTarget): Promise<unknown>;
  turns?(
    target: FlaryThreadTarget,
    input: ThreadRecordListRequest,
  ): Promise<readonly unknown[]>;
  auditList?(
    target: FlaryThreadTarget,
    input: ThreadRecordListRequest,
  ): Promise<readonly unknown[]>;
  auditExport?(target: FlaryThreadTarget): Promise<ReadableStream<Uint8Array> | string>;
  subagentAction?(
    target: FlaryThreadTarget,
    action: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  scheduleAction?(
    target: FlaryThreadTarget,
    action: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  processAction?(
    target: FlaryThreadTarget,
    action: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  browserAction?(
    target: FlaryThreadTarget,
    action: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  listApprovals(target: FlaryThreadTarget): Promise<unknown[]>;
  decideApproval(
    target: FlaryThreadTarget,
    decision: ApprovalDecision,
  ): Promise<void>;
  listUserInput?(target: FlaryThreadTarget): Promise<UserInputRecord[]>;
  respondToUserInput?(
    target: FlaryThreadTarget,
    requestId: string,
    response: UserInputAnswerRequest,
  ): Promise<{ live: boolean; admission?: FlaryThreadAdmission }>;
  operationalState?(
    target: FlaryThreadTarget,
  ): Promise<z.output<typeof ThreadOperationalStateSchema>>;
  history?(
    target: FlaryThreadTarget,
    limit: number,
  ): Promise<ThreadHistoryListResponse>;
  historyDiff?(
    target: FlaryThreadTarget,
    input: {
      baseCommitId?: string;
      headCommitId: string;
    },
  ): Promise<ThreadHistoryDiffResponse>;
  historyRestore?(
    target: FlaryThreadTarget,
    input: import("../contracts/threads.js").ThreadHistoryRestoreRequest,
  ): Promise<unknown>;
  recallSearch?(
    target: FlaryThreadTarget,
    input: FlaryRecallSearchRequest,
  ): Promise<RecallSearchResponse>;
  recallOpen?(
    target: FlaryThreadTarget,
    input: FlaryRecallOpenRequest,
  ): Promise<RecallDocument | undefined>;
}

export {
  AgentModeIdSchema,
  ApprovalDecisionSchema,
  FlaryHostAuthorizationSchema as HostAuthorizationSchema,
  RecallDocumentSchema,
  RecallSearchResponseSchema,
  ThreadBindingSchema,
  ThreadCreateRequestSchema,
  ThreadForkRequestSchema,
  ThreadHistoryDiffResponseSchema,
  ThreadHistoryListResponseSchema,
  ThreadMessageRequestSchema,
  UserInputAnswerRequestSchema,
  UserInputRecordSchema,
  ThreadOperationalStateSchema,
  ThreadRefSchema,
};

export type {
  AgentModeId,
  ApprovalDecision,
  IdentityReference,
  RecallDocument,
  RecallSearchResponse,
  ThreadBinding,
  ThreadCreateRequest,
  ThreadCompactRequest,
  ThreadForkRequest,
  ThreadGoalRequest,
  ThreadHistoryDiffResponse,
  ThreadHistoryListResponse,
  ThreadMessageRequest,
  ThreadPinRequest,
  ThreadReadRequest,
  ThreadRecordListRequest,
  ThreadRenameRequest,
  ThreadRollbackRequest,
  ThreadRef,
};
