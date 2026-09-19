import { z } from "zod";

import { SessionSha256Schema } from "./contracts.js";

/** The beta.9 canonical stream is the source of truth for this bridge archive. */
export const LEGACY_EXPORT_FORMAT = "flary-legacy-export" as const;
export const LEGACY_EXPORT_VERSION = 1 as const;
export const LEGACY_EXPORT_SOURCE_REVISION = "npm:@flue/runtime-legacy@1.0.0-beta.9" as const;
/**
 * A deliberately conservative 15-minute lease bounds crash recovery while
 * allowing large beta.9 archives to finish without a false takeover.
 */
export const LEGACY_EXPORT_LEASE_MS = 15 * 60 * 1000;

export const LegacyExportOutcomeSchema = z.enum([
  "exported",
  "already_exported",
  "active",
  "failed",
]);
export type LegacyExportOutcome = z.infer<typeof LegacyExportOutcomeSchema>;

export const LegacyExportErrorCodeSchema = z.enum([
  "legacy_export_active",
  "legacy_export_conflict",
  "legacy_export_missing_attachment",
  "legacy_export_integrity",
  "legacy_export_unavailable",
  "legacy_export_failed",
]);
export type LegacyExportErrorCode = z.infer<typeof LegacyExportErrorCodeSchema>;

export const LegacyExportAttachmentSchema = z
  .object({
    id: z.string().min(1),
    mimeType: z.string().min(1),
    size: z.number().int().nonnegative(),
    digest: SessionSha256Schema,
    filename: z.string().optional(),
    conversationId: z.string().min(1),
    chunkCount: z.number().int().positive(),
    chunkDigests: z.array(SessionSha256Schema),
    storageKey: z.string().min(1),
  })
  .strict();
export type LegacyExportAttachment = z.infer<typeof LegacyExportAttachmentSchema>;

export const LegacyExportBatchSchema = z
  .object({
    index: z.number().int().nonnegative(),
    recordCount: z.number().int().nonnegative(),
    recordIds: z.array(z.string()),
    sha256: SessionSha256Schema,
  })
  .strict();
export type LegacyExportBatch = z.infer<typeof LegacyExportBatchSchema>;

export const LegacyExportManifestSchema = z
  .object({
    format: z.literal(LEGACY_EXPORT_FORMAT),
    version: z.literal(LEGACY_EXPORT_VERSION),
    storageKey: z.string().min(1),
    thread: z
      .object({
        tenantId: z.string().min(1),
        applicationId: z.string().min(1),
        threadId: z.string().min(1),
        agentId: z.string().min(1),
      })
      .strict(),
    source: z
      .object({
        runtime: z.literal("@flue/runtime-legacy"),
        version: z.literal("1.0.0-beta.9"),
        revision: z.string().min(1),
      })
      .strict(),
    createdAt: z.string().datetime({ offset: true }),
    exportedAt: z.string().datetime({ offset: true }),
    canonical: z
      .object({
        format: z.literal("flue-canonical"),
        version: z.literal(1),
        storageKey: z.string().min(1),
        batchCount: z.number().int().nonnegative(),
        batches: z.array(LegacyExportBatchSchema),
        throughTurnId: z.string().optional(),
      })
      .strict(),
    digest: z
      .object({
        algorithm: z.literal("SHA-256"),
        value: SessionSha256Schema,
        /** Explicitly excludes createdAt/exportedAt and storage keys. */
        input: z.literal("canonical-batches-and-attachment-digests-v1"),
      })
      .strict(),
    attachments: z.array(LegacyExportAttachmentSchema),
    /** This marker is descriptive; the SQLite registry is the commit marker. */
    completionMarker: z.literal("legacy-export-complete-v1"),
  })
  .strict();
export type LegacyExportManifest = z.infer<typeof LegacyExportManifestSchema>;

const LegacyExportSuccessSchema = z
  .object({
    outcome: z.enum(["exported", "already_exported"]),
    threadId: z.string().min(1),
    digest: SessionSha256Schema,
    manifest: LegacyExportManifestSchema,
  })
  .strict();
const LegacyExportActiveSchema = z
  .object({
    outcome: z.literal("active"),
    threadId: z.string().min(1),
    errorCode: z.literal("legacy_export_active"),
    message: z.string().min(1),
  })
  .strict();
const LegacyExportFailureSchema = z
  .object({
    outcome: z.literal("failed"),
    threadId: z.string().min(1),
    errorCode: LegacyExportErrorCodeSchema,
    message: z.string().min(1),
  })
  .strict();

export const LegacyExportResultSchema = z.discriminatedUnion("outcome", [
  LegacyExportSuccessSchema,
  LegacyExportActiveSchema,
  LegacyExportFailureSchema,
]);
export type LegacyExportResult = z.infer<typeof LegacyExportResultSchema>;

export class LegacyExportError extends Error {
  readonly code: LegacyExportErrorCode;

  constructor(code: LegacyExportErrorCode, message: string) {
    super(message);
    this.name = "LegacyExportError";
    this.code = code;
  }
}

export class LegacyExportConflictError extends LegacyExportError {
  readonly existingDigest: string;
  readonly requestedDigest: string;

  constructor(existingDigest: string, requestedDigest: string) {
    super(
      "legacy_export_conflict",
      `The legacy thread already has immutable archive ${existingDigest}; source digest ${requestedDigest} differs`,
    );
    this.name = "LegacyExportConflictError";
    this.existingDigest = existingDigest;
    this.requestedDigest = requestedDigest;
  }
}

export class LegacyExportActiveError extends LegacyExportError {
  constructor(message = "The legacy thread has an unsettled submission") {
    super("legacy_export_active", message);
    this.name = "LegacyExportActiveError";
  }
}

export class LegacyExportAttachmentError extends LegacyExportError {
  readonly attachmentId: string;

  constructor(attachmentId: string, message = `Attachment '${attachmentId}' is missing`) {
    super("legacy_export_missing_attachment", message);
    this.name = "LegacyExportAttachmentError";
    this.attachmentId = attachmentId;
  }
}

/**
 * Structural beta attachment reference. Traversal intentionally recognizes only
 * objects with the canonical `{ type: "attachment", attachment: ... }` shape;
 * arbitrary `id` fields in tool arguments are never treated as attachments.
 */
export interface LegacyAttachmentReference {
  readonly id: string;
  readonly mimeType: string;
  readonly size: number;
  readonly digest: string;
  readonly filename?: string;
}

export interface LegacyCanonicalArchive {
  readonly format: "flue-canonical";
  readonly version: 1;
  readonly batches: readonly (readonly unknown[])[];
  readonly throughTurnId?: string;
}

/** Discover canonical attachment references while preserving first-seen order. */
export function discoverLegacyAttachmentReferences(
  canonical: unknown,
): readonly LegacyAttachmentReference[] {
  const found = new Map<string, LegacyAttachmentReference>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "attachment") {
      const attachment =
        record.attachment && typeof record.attachment === "object"
          ? (record.attachment as Record<string, unknown>)
          : {};
      if (
        typeof attachment.id !== "string" ||
        typeof attachment.mimeType !== "string" ||
        typeof attachment.size !== "number" ||
        !Number.isSafeInteger(attachment.size) ||
        attachment.size < 0 ||
        typeof attachment.digest !== "string" ||
        !/^[0-9a-f]{64}$/.test(attachment.digest)
      ) {
        throw new LegacyExportAttachmentError(
          typeof attachment.id === "string" ? attachment.id : "unknown",
          "A canonical attachment reference is malformed",
        );
      }
      const reference: LegacyAttachmentReference = {
        id: attachment.id,
        mimeType: attachment.mimeType,
        size: attachment.size,
        digest: attachment.digest,
        ...(typeof attachment.filename === "string" ? { filename: attachment.filename } : {}),
      };
      const previous = found.get(reference.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(reference)) {
        throw new LegacyExportAttachmentError(
          reference.id,
          `Attachment '${reference.id}' has conflicting canonical metadata`,
        );
      }
      found.set(reference.id, reference);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(canonical);
  return [...found.values()];
}

/**
 * Build the digest input. Timestamps, completion state, and storage keys are
 * deliberately absent so retries of identical source bytes are idempotent.
 */
export function legacyExportDigestInput(input: {
  readonly thread: LegacyExportManifest["thread"];
  readonly sourceRevision: string;
  readonly canonical: LegacyCanonicalArchive;
  readonly attachments: readonly {
    readonly id: string;
    readonly mimeType: string;
    readonly size: number;
    readonly digest: string;
    readonly filename?: string;
    readonly conversationId: string;
    readonly chunkCount: number;
    readonly chunkDigests: readonly string[];
  }[];
}): unknown {
  return {
    format: LEGACY_EXPORT_FORMAT,
    version: LEGACY_EXPORT_VERSION,
    thread: input.thread,
    source: {
      runtime: "@flue/runtime-legacy",
      version: "1.0.0-beta.9",
      revision: input.sourceRevision,
    },
    canonical: {
      format: input.canonical.format,
      version: input.canonical.version,
      ...(input.canonical.throughTurnId ? { throughTurnId: input.canonical.throughTurnId } : {}),
      batches: input.canonical.batches,
    },
    attachments: input.attachments.map((attachment) => ({
      id: attachment.id,
      mimeType: attachment.mimeType,
      size: attachment.size,
      digest: attachment.digest,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      conversationId: attachment.conversationId,
      chunkCount: attachment.chunkCount,
      chunkDigests: [...attachment.chunkDigests],
    })),
  };
}

export async function legacyExportDigest(
  input: Parameters<typeof legacyExportDigestInput>[0],
): Promise<string> {
  return sha256Text(stableJson(legacyExportDigestInput(input)));
}

/** Build ordered batch metadata without changing canonical record order/boundaries. */
export async function legacyExportBatchMetadata(
  canonical: LegacyCanonicalArchive,
): Promise<readonly LegacyExportBatch[]> {
  return Promise.all(
    canonical.batches.map(async (records, index) => ({
      index,
      recordCount: records.length,
      recordIds: records.flatMap((record) => {
        if (!record || typeof record !== "object") return [];
        const id = (record as Record<string, unknown>).id;
        return typeof id === "string" ? [id] : [];
      }),
      sha256: await sha256Text(stableJson(records)),
    })),
  );
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export interface LegacyExportArchiveBucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

/**
 * Deterministic-key encrypted R2 object store. Keys are content-addressed,
 * while the object ciphertext remains randomized by its per-object nonce.
 */
export class LegacyExportArchiveStore {
  readonly #bucket: LegacyExportArchiveBucket;
  readonly #secret: string;

  constructor(input: { readonly bucket: LegacyExportArchiveBucket; readonly secret: string }) {
    if (input.secret.length < 32) {
      throw new Error("FLARY_SESSION_ARCHIVE_KEY must have at least 32 characters");
    }
    this.#bucket = input.bucket;
    this.#secret = input.secret;
  }

  async put(key: string, plaintext: Uint8Array): Promise<void> {
    const encrypted = await this.#encrypt(key, plaintext);
    await this.#bucket.put(key, encrypted, {
      customMetadata: { sha256: await sha256Bytes(plaintext), encoding: "aes-256-gcm" },
    });
    const roundTrip = await this.get(key);
    if (!roundTrip || (await sha256Bytes(roundTrip)) !== (await sha256Bytes(plaintext))) {
      throw new LegacyExportError(
        "legacy_export_integrity",
        `Archive object '${key}' failed read-back verification`,
      );
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const object = await this.#bucket.get(key);
    if (!object) return null;
    const encrypted = new Uint8Array(await object.arrayBuffer());
    if (encrypted.byteLength < 12) {
      throw new LegacyExportError(
        "legacy_export_integrity",
        `Archive object '${key}' is truncated`,
      );
    }
    const nonce = encrypted.subarray(0, 12);
    const ciphertext = encrypted.subarray(12);
    try {
      return new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: toArrayBuffer(nonce),
            additionalData: toArrayBuffer(new TextEncoder().encode(key)),
          },
          await this.key(),
          toArrayBuffer(ciphertext),
        ),
      );
    } catch {
      throw new LegacyExportError(
        "legacy_export_integrity",
        `Archive object '${key}' failed decryption`,
      );
    }
  }

  async #encrypt(key: string, plaintext: Uint8Array): Promise<Uint8Array> {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(nonce),
          additionalData: toArrayBuffer(new TextEncoder().encode(key)),
        },
        await this.key(),
        toArrayBuffer(plaintext),
      ),
    );
    const result = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
    result.set(nonce);
    result.set(ciphertext, nonce.byteLength);
    return result;
  }

  async key(): Promise<CryptoKey> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.#secret));
    return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
}

export function legacyExportObjectKey(threadId: string, digest: string, suffix: string): string {
  return `legacy-exports/${encodeURIComponent(threadId)}/${digest}/${suffix}`;
}

export function legacyExportAttachmentKey(
  threadId: string,
  digest: string,
  attachmentId: string,
  attachmentDigest: string,
): string {
  return legacyExportObjectKey(
    threadId,
    digest,
    `attachments/${encodeURIComponent(attachmentId)}-${attachmentDigest}.bin.aes`,
  );
}
