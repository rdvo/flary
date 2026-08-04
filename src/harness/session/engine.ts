import { z } from "zod";

export const SessionEnginePinSchema = z.object({
  id: z.enum(["flue-legacy", "flue-2"]),
  version: z.string().min(1).max(64),
  revision: z.string().min(1).max(256),
}).strict();
export type SessionEnginePin = z.infer<typeof SessionEnginePinSchema>;

export const SessionEngineCapabilitiesSchema = z.object({
  durableAdmission: z.boolean(),
  durableObservation: z.boolean(),
  manualCompaction: z.boolean(),
  activePathRollback: z.boolean(),
  exactCanonicalExport: z.boolean(),
  exactCanonicalRestore: z.boolean(),
  perSubmissionModelPin: z.boolean(),
  approvalContinuation: z.boolean(),
}).strict();
export type SessionEngineCapabilities = z.infer<
  typeof SessionEngineCapabilitiesSchema
>;

/** Capabilities that a new interactive Flary thread must not lose. */
export const REQUIRED_INTERACTIVE_ENGINE_CAPABILITIES = [
  "durableAdmission",
  "durableObservation",
  "manualCompaction",
  "activePathRollback",
  "exactCanonicalExport",
  "exactCanonicalRestore",
  "perSubmissionModelPin",
  "approvalContinuation",
] as const satisfies readonly (keyof SessionEngineCapabilities)[];

export interface SessionEngineAdmission {
  readonly submissionId: string;
  readonly cursor: string;
  readonly duplicate?: boolean;
}

export interface SessionEngineForkArchive {
  readonly format: "flary-session-engine";
  readonly version: 1;
  readonly source: SessionEnginePin;
  readonly threadId: string;
  readonly throughTurnId?: string;
  readonly sha256: string;
  readonly payload: unknown;
}

/** The version boundary between Flary Thread Control and its transcript owner. */
export interface SessionEngine {
  readonly pin: SessionEnginePin;
  readonly capabilities: SessionEngineCapabilities;
  submit(input: {
    readonly agentId: string;
    readonly threadId: string;
    readonly message: string;
    readonly idempotencyKey: string;
    readonly model?: string;
    readonly thinkingLevel?: string;
    readonly cacheRetention?: "none" | "short" | "long";
    readonly images?: readonly unknown[];
  }): Promise<SessionEngineAdmission>;
  observe(
    admission: SessionEngineAdmission,
    onEvent: (event: Readonly<Record<string, unknown>>) => Promise<void>,
  ): Promise<unknown>;
  cancel(agentId: string, threadId: string): Promise<void>;
  compact(agentId: string, threadId: string, reason?: string): Promise<unknown>;
  rollback(input: {
    readonly agentId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly reason?: string;
    readonly excludeTarget?: boolean;
  }): Promise<unknown>;
  export(input: {
    readonly agentId: string;
    readonly threadId: string;
    readonly throughTurnId?: string;
  }): Promise<SessionEngineForkArchive>;
  restore(input: {
    readonly agentId: string;
    readonly threadId: string;
    readonly archive: SessionEngineForkArchive;
  }): Promise<void>;
  active(agentId: string, threadId: string): Promise<boolean>;
}

export interface SessionEngineMigrationStore {
  append(input: {
    readonly recordType: "runtime.migrated";
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
}

/** Migrate only idle sessions and verify the immutable archive before import. */
export async function migrateSessionEngine(input: {
  readonly source: SessionEngine;
  readonly target: SessionEngine;
  readonly agentId: string;
  readonly threadId: string;
  readonly ledger: SessionEngineMigrationStore;
}): Promise<{ source: SessionEnginePin; target: SessionEnginePin; sha256: string }> {
  assertInteractiveSessionEngine(input.target);
  if (await input.source.active(input.agentId, input.threadId)) {
    throw new Error("An active session cannot change its session engine");
  }
  const archive = await input.source.export({
    agentId: input.agentId,
    threadId: input.threadId,
  });
  const actual = await sha256Json(archive.payload);
  if (actual !== archive.sha256) {
    throw new Error("The session engine archive hash does not match");
  }
  await input.target.restore({
    agentId: input.agentId,
    threadId: input.threadId,
    archive,
  });
  await input.ledger.append({
    recordType: "runtime.migrated",
    payload: {
      source: input.source.pin,
      target: input.target.pin,
      archiveSha256: archive.sha256,
      migratedAt: new Date().toISOString(),
    },
  });
  return { source: input.source.pin, target: input.target.pin, sha256: archive.sha256 };
}

/** Fail closed before a new thread or migration selects an incomplete engine. */
export function assertInteractiveSessionEngine(
  engine: Pick<SessionEngine, "pin" | "capabilities">,
): void {
  const capabilities = SessionEngineCapabilitiesSchema.parse(engine.capabilities);
  const missing = REQUIRED_INTERACTIVE_ENGINE_CAPABILITIES.filter(
    (name) => !capabilities[name],
  );
  if (missing.length === 0) return;
  throw new Error(
    `Session engine ${engine.pin.id}@${engine.pin.version} is missing required capabilities: ${missing.join(", ")}`,
  );
}

/**
 * Public Flue 2.0.2 capabilities as used by Flary.
 *
 * Flue 2 owns durable admission and observation. It supports compaction from
 * inside an agent harness, but its public Cloudflare control surface does not
 * expose the external `SessionEngine.compact()` operation. It also does not
 * yet expose Flary's append-only rollback,
 * exact canonical import/export, per-submission model pin, or approval pause
 * continuation contracts. Keep these false until executable adapters and
 * recovery tests prove the full behavior.
 */
export const FLUE_2_0_2_FLARY_CAPABILITIES =
  SessionEngineCapabilitiesSchema.parse({
    durableAdmission: true,
    durableObservation: true,
    manualCompaction: false,
    activePathRollback: false,
    exactCanonicalExport: false,
    exactCanonicalRestore: false,
    perSubmissionModelPin: false,
    approvalContinuation: false,
  });

/** Return true when a package version must pass the stable Flue 2 gate. */
export function requiresFlue2StableRelease(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  if (!match) throw new Error(`Invalid release version ${version}`);
  if (match[4]) return false;
  return Number(match[1]) > 0 || Number(match[2]) >= 8;
}

export async function loadPinnedFlue2Runtime(): Promise<{
  readonly version: "2.0.2";
  readonly runtime: typeof import("@flue/runtime-v2");
  readonly sdk: typeof import("@flue/sdk-v2");
  readonly capabilities: SessionEngineCapabilities;
}> {
  const [runtime, sdk] = await Promise.all([
    import("@flue/runtime-v2"),
    import("@flue/sdk-v2"),
  ]);
  return {
    version: "2.0.2",
    runtime,
    sdk,
    capabilities: FLUE_2_0_2_FLARY_CAPABILITIES,
  };
}

async function sha256Json(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
