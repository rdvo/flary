import { z } from "zod";

export const SecretNameSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "Secret names must contain only safe identifier characters");

const SecretRefCanonicalSchema = z
  .object({
    kind: z.literal("secret-ref"),
    name: SecretNameSchema,
    version: z.string().min(1).max(256).optional(),
    scope: z.string().min(1).max(512).optional(),
  })
  .strict();

/** A non-secret pointer to a value held by a secret provider. */
export const SecretRefSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    return { kind: "secret-ref", name: value };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const input = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    kind: input.kind ?? input.type ?? "secret-ref",
    name: input.name ?? input.key,
  };
  if (input.version !== undefined) normalized.version = input.version;
  const scope = input.scope ?? input.namespace;
  if (scope !== undefined) normalized.scope = scope;
  return normalized;
}, SecretRefCanonicalSchema);

export type SecretRef = z.infer<typeof SecretRefCanonicalSchema>;

export const SecretValueSchema = z.union([z.string(), z.instanceof(Uint8Array)]);
export type SecretValue = string | Uint8Array;

export const Base64UrlSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/, "Expected unpadded base64url data");

export const ENCRYPTED_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const AES_256_GCM_ALGORITHM = "AES-256-GCM" as const;

/** A serialisable AES-GCM envelope. Values are unpadded base64url strings. */
export const EncryptedEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(ENCRYPTED_ENVELOPE_SCHEMA_VERSION),
    algorithm: z.literal(AES_256_GCM_ALGORITHM),
    keyId: z.string().min(1).max(512),
    iv: Base64UrlSchema,
    ciphertext: Base64UrlSchema,
    wrappedKey: Base64UrlSchema.optional(),
    wrappedKeyIv: Base64UrlSchema.optional(),
    additionalData: Base64UrlSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.wrappedKey === undefined) !== (value.wrappedKeyIv === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "wrappedKey and wrappedKeyIv must be provided together",
        path: ["wrappedKey"],
      });
    }
  });

export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;

export type Aes256GcmKey = CryptoKey;

/** A provider for a key-encryption key. It never receives a plaintext secret. */
export interface EnvelopeKeyProvider {
  getKey(keyId: string): Promise<Uint8Array | Aes256GcmKey | undefined>;
}

export type KeyProvider = EnvelopeKeyProvider;

export interface EnvelopeEncryptOptions {
  keyId: string;
  additionalData?: Uint8Array;
}

export interface EnvelopeDecryptOptions {
  /** If supplied, this must match the data used during encryption. */
  additionalData?: Uint8Array;
}

/** Provider-neutral contract for authenticated envelope encryption. */
export interface EnvelopeEncryptor {
  encrypt(plaintext: Uint8Array, options: EnvelopeEncryptOptions): Promise<EncryptedEnvelope>;
  decrypt(
    envelope: EncryptedEnvelope,
    options?: EnvelopeDecryptOptions,
  ): Promise<Uint8Array>;
}

export interface SecretProvider {
  get(ref: SecretRef): Promise<SecretValue | undefined>;
}

export type SecretResolver = SecretProvider;

export function parseSecretRef(value: unknown): SecretRef {
  return SecretRefSchema.parse(value);
}

export function isSecretRef(value: unknown): value is SecretRef {
  return SecretRefSchema.safeParse(value).success;
}
