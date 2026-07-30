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
  ThreadForkRequestSchema,
  ThreadHistoryDiffResponseSchema,
  ThreadHistoryListResponseSchema,
  ThreadMessageRequestSchema,
  type ThreadBinding,
  type ThreadCreateRequest,
  type ThreadForkRequest,
  type ThreadHistoryDiffResponse,
  type ThreadHistoryListResponse,
  type ThreadMessageRequest,
} from "../contracts/threads.js";
import {
  UserInputAnswerRequestSchema,
  UserInputRecordSchema,
  type UserInputAnswerRequest,
  type UserInputRecord,
} from "../contracts/user-input.js";
import { ThreadOperationalStateSchema } from "../contracts/runtime.js";
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
  archive(target: FlaryThreadTarget): Promise<ThreadBinding>;
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
  submit(
    target: FlaryThreadTarget,
    input: ThreadMessageRequest,
  ): Promise<FlaryThreadAdmission>;
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
  ThreadForkRequest,
  ThreadHistoryDiffResponse,
  ThreadHistoryListResponse,
  ThreadMessageRequest,
  ThreadRef,
};
