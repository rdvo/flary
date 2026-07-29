import { z } from "zod";

import {
  createEventRecord,
  createRecordId,
  nowIsoTimestamp,
  EventRecordSchema,
  type EventRecord,
  type EventSeverity,
  type EventStatus,
} from "../storage/records";
import {
  SecretRefSchema,
  type SecretProvider,
  type SecretRef,
  type SecretValue,
} from "./types";

export const MISSING_SECRET_PAUSE_EVENT_TYPE = "run.paused.missing-secret" as const;
export const MISSING_SECRET_REASON = "missing-secret" as const;

export const MissingSecretPauseEventSchema = EventRecordSchema.extend({
  eventType: z.literal(MISSING_SECRET_PAUSE_EVENT_TYPE),
  status: z.literal("paused"),
  severity: z.literal("warning"),
  payload: z
    .object({
      reason: z.literal(MISSING_SECRET_REASON),
      secretRef: SecretRefSchema,
      resumable: z.literal(true),
    })
    .strict(),
});

export type MissingSecretPauseEvent = z.infer<typeof MissingSecretPauseEventSchema>;

export interface MissingSecretPauseOptions {
  id?: string;
  createdAt?: string;
  threadId?: string;
  turnId?: string;
  operationId?: string;
}

/** Creates a pause event that contains a reference, never the secret value. */
export function createMissingSecretPauseEvent(
  refInput: SecretRef | string,
  options: MissingSecretPauseOptions = {},
): MissingSecretPauseEvent {
  const secretRef = SecretRefSchema.parse(refInput);
  return MissingSecretPauseEventSchema.parse(
    createEventRecord({
      id: options.id ?? createRecordId("pause"),
      createdAt: options.createdAt ?? nowIsoTimestamp(),
      eventType: MISSING_SECRET_PAUSE_EVENT_TYPE,
      status: "paused",
      severity: "warning",
      threadId: options.threadId,
      turnId: options.turnId,
      operationId: options.operationId,
      payload: {
        reason: MISSING_SECRET_REASON,
        secretRef,
        resumable: true,
      },
    }),
  );
}

export class MissingSecretError extends Error {
  readonly event: MissingSecretPauseEvent;

  constructor(event: MissingSecretPauseEvent) {
    super(`Required secret is not available: ${event.payload.secretRef.name}`);
    this.name = "MissingSecretError";
    this.event = event;
  }
}

export type SecretWithResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "paused"; readonly event: MissingSecretPauseEvent };

export interface SecretAccessOptions extends MissingSecretPauseOptions {}

export interface SecretsContext {
  resolve(ref: SecretRef | string): Promise<SecretValue | undefined>;
  /**
   * Runs a callback while the secret is available. The callback is never
   * called when the secret is missing. Missing values raise MissingSecretError
   * and expose a pause event through the error.
   */
  with<T>(
    ref: SecretRef | string,
    callback: (value: SecretValue) => T | PromiseLike<T>,
    options?: SecretAccessOptions,
  ): Promise<T>;
  /** A non-throwing form for runners that pause instead of handling errors. */
  withResult<T>(
    ref: SecretRef | string,
    callback: (value: SecretValue) => T | PromiseLike<T>,
    options?: SecretAccessOptions,
  ): Promise<SecretWithResult<T>>;
}

export interface SecretsContextOptions {
  provider: SecretProvider;
  defaultPause?: MissingSecretPauseOptions;
}

function cloneSecret(value: SecretValue): SecretValue {
  return typeof value === "string" ? value : new Uint8Array(value);
}

function normalizeRef(ref: SecretRef | string): SecretRef {
  return SecretRefSchema.parse(ref);
}

export function createSecretsContext(options: SecretsContextOptions): SecretsContext {
  const resolve = async (refInput: SecretRef | string): Promise<SecretValue | undefined> => {
    const ref = normalizeRef(refInput);
    const value = await options.provider.get(ref);
    return value === undefined ? undefined : cloneSecret(value);
  };

  const getPauseEvent = (ref: SecretRef, accessOptions?: SecretAccessOptions) =>
    createMissingSecretPauseEvent(ref, {
      ...options.defaultPause,
      ...accessOptions,
    });

  const withSecret = async <T>(
    refInput: SecretRef | string,
    callback: (value: SecretValue) => T | PromiseLike<T>,
    accessOptions?: SecretAccessOptions,
  ): Promise<T> => {
    const ref = normalizeRef(refInput);
    const value = await resolve(ref);
    if (value === undefined) {
      throw new MissingSecretError(getPauseEvent(ref, accessOptions));
    }

    const callbackValue = cloneSecret(value);
    try {
      return await callback(callbackValue);
    } finally {
      if (callbackValue instanceof Uint8Array) {
        callbackValue.fill(0);
      }
    }
  };

  const withResult = async <T>(
    refInput: SecretRef | string,
    callback: (value: SecretValue) => T | PromiseLike<T>,
    accessOptions?: SecretAccessOptions,
  ): Promise<SecretWithResult<T>> => {
    const ref = normalizeRef(refInput);
    try {
      return { status: "ok", value: await withSecret(ref, callback, accessOptions) };
    } catch (error) {
      if (error instanceof MissingSecretError) {
        return { status: "paused", event: error.event };
      }
      throw error;
    }
  };

  return { resolve, with: withSecret, withResult };
}

export interface HarnessContext {
  readonly secrets: SecretsContext;
}

export function createHarnessContext(options: SecretsContextOptions): HarnessContext {
  return { secrets: createSecretsContext(options) };
}

export function isMissingSecretPauseEvent(value: unknown): value is MissingSecretPauseEvent {
  return MissingSecretPauseEventSchema.safeParse(value).success;
}

export type MissingSecretEvent = MissingSecretPauseEvent;
export const MissingSecretEventSchema = MissingSecretPauseEventSchema;

