import { z } from "zod";

/** A value that can be stored without requiring a platform-specific blob API. */
export type BlobInput = ArrayBuffer | ArrayBufferView;

const BlobKeySchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !/[\u0000\r\n]/.test(value), "Blob keys cannot contain control characters");

const Sha256Schema = z
  .string()
  .regex(/^(?:[0-9a-fA-F]{64}|[A-Za-z0-9_-]{43,44})$/, "Expected a SHA-256 digest");

const BlobRefCanonicalSchema = z
  .object({
    kind: z.literal("blob-ref"),
    id: z.string().min(1).max(512).optional(),
    key: BlobKeySchema,
    mediaType: z.string().min(1).max(255),
    size: z.number().int().nonnegative(),
    sha256: Sha256Schema,
  })
  .strict();

/**
 * A stable reference to immutable bytes.
 *
 * The schema accepts common input aliases and always returns the canonical
 * `kind`, `mediaType`, and `size` fields. A digest is required so a caller can
 * verify the bytes after a durable-store round trip.
 */
export const BlobRefSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const input = value as Record<string, unknown>;
  return {
    kind: input.kind ?? input.type ?? "blob-ref",
    id: input.id,
    key: input.key ?? input.storageKey ?? input.uri,
    mediaType: input.mediaType ?? input.contentType ?? input.mimeType,
    size: input.size ?? input.byteLength,
    sha256: input.sha256 ?? input.digest,
  };
}, BlobRefCanonicalSchema);

export type BlobRef = z.infer<typeof BlobRefCanonicalSchema>;

/** Metadata used when a blob is written. It contains no blob contents. */
export const BlobMetadataSchema = z
  .object({
    key: BlobKeySchema.optional(),
    mediaType: z.string().min(1).max(255).default("application/octet-stream"),
  })
  .strict();

export type BlobMetadata = z.infer<typeof BlobMetadataSchema>;

/**
 * Storage for immutable byte objects.
 *
 * Implementations can use a local file, object storage, or a future platform
 * binding. This interface does not depend on any of those implementations.
 */
export interface BlobStore {
  put(data: BlobInput, metadata?: BlobMetadata): Promise<BlobRef>;
  get(ref: BlobRef): Promise<Uint8Array | undefined>;
  has(ref: BlobRef): Promise<boolean>;
}

export type BlobReference = BlobRef;
export const BlobReferenceSchema = BlobRefSchema;

export function parseBlobRef(value: unknown): BlobRef {
  return BlobRefSchema.parse(value);
}

