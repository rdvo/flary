import { z } from "zod";
import {
  approvalDecisionSchema,
  approvalPolicySchema,
  type ApprovalDecision,
  type ApprovalHandler,
  type ApprovalPolicy,
  type ApprovalPolicyInput,
  type ApprovalRequest,
  type ToolTask,
} from "./types.js";
import { normalizeToolTask } from "./normalize.js";

export interface ApprovalGateOptions {
  readonly policy?: ApprovalPolicyInput;
  readonly handler?: ApprovalHandler;
}

function approvalKeyFor(task: ToolTask): string {
  return task.approvalKey ?? task.idempotencyKey ?? `task:${task.id}`;
}

function parseApprovalOptions(options: ApprovalGateOptions | ApprovalHandler | undefined): {
  policy: ApprovalPolicy;
  handler?: ApprovalHandler;
} {
  if (typeof options === "function") {
    return {
      policy: approvalPolicySchema.parse({}),
      handler: options,
    };
  }

  if (options === undefined) {
    return { policy: approvalPolicySchema.parse({}) };
  }

  const object = z
    .object({
      policy: approvalPolicySchema.optional(),
      handler: z.unknown().optional(),
    })
    .strict()
    .parse(options);

  const handler =
    object.handler === undefined
      ? undefined
      : z.custom<ApprovalHandler>((value) => typeof value === "function").parse(object.handler);

  return {
    policy: approvalPolicySchema.parse(object.policy ?? {}),
    handler,
  };
}

export function taskNeedsApproval(task: ToolTask, policy: ApprovalPolicyInput = {}): boolean {
  const normalizedTask = normalizeToolTask(task);
  const parsedPolicy = approvalPolicySchema.parse(policy);
  return (
    normalizedTask.requiresApproval ||
    (normalizedTask.operation === "write" && parsedPolicy.requireForWrites) ||
    parsedPolicy.requiredTools.includes(normalizedTask.name)
  );
}

export class ApprovalGate {
  readonly #policy: ApprovalPolicy;
  readonly #handler?: ApprovalHandler;
  readonly #decisions = new Map<string, ApprovalDecision>();
  readonly #pending = new Map<string, Promise<ApprovalDecision>>();

  constructor(options?: ApprovalGateOptions | ApprovalHandler) {
    const parsed = parseApprovalOptions(options);
    this.#policy = parsed.policy;
    this.#handler = parsed.handler;
  }

  get policy(): ApprovalPolicy {
    return this.#policy;
  }

  requiresApproval(task: ToolTask): boolean {
    return taskNeedsApproval(task, this.#policy);
  }

  async request(task: ToolTask): Promise<ApprovalDecision> {
    const normalizedTask = normalizeToolTask(task);
    if (!this.requiresApproval(normalizedTask)) {
      return { approved: true };
    }

    const key = approvalKeyFor(normalizedTask);
    const previous = this.#decisions.get(key);
    if (previous) {
      return previous;
    }

    const pending = this.#pending.get(key);
    if (pending) {
      return pending;
    }

    const request: ApprovalRequest = { key, task: normalizedTask };
    const decisionPromise = this.resolve(request);
    this.#pending.set(key, decisionPromise);

    try {
      const decision = await decisionPromise;
      this.#decisions.set(key, decision);
      return decision;
    } finally {
      this.#pending.delete(key);
    }
  }

  async check(task: ToolTask): Promise<ApprovalDecision> {
    return this.request(task);
  }

  approve(key: string): void {
    z.string().trim().min(1).parse(key);
    this.#decisions.set(key, { approved: true });
  }

  deny(key: string, reason = "Approval denied"): void {
    z.string().trim().min(1).parse(key);
    z.string().parse(reason);
    this.#decisions.set(key, { approved: false, reason });
  }

  clear(key?: string): void {
    if (key === undefined) {
      this.#decisions.clear();
      return;
    }
    z.string().trim().min(1).parse(key);
    this.#decisions.delete(key);
  }

  private async resolve(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (!this.#handler) {
      return { approved: false, reason: "Approval is required" };
    }

    const decision = await this.#handler(request);
    return approvalDecisionSchema.parse(decision);
  }
}

export const createApprovalGate = (options?: ApprovalGateOptions | ApprovalHandler): ApprovalGate =>
  new ApprovalGate(options);
