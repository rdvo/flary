import { z } from "zod";

const EncryptedTokenSchema = z
  .object({
    ciphertext: z.string().min(1),
    iv: z.string().min(1),
  })
  .strict();

export type EncryptedToken = z.infer<typeof EncryptedTokenSchema>;

function encode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer as ArrayBuffer;
}

async function keyFromConfig(value: string): Promise<CryptoKey> {
  const raw = decode(value);
  if (raw.byteLength !== 32) {
    throw new Error("FLARY_TOKEN_ENCRYPTION_KEY_B64 must decode to 32 bytes");
  }
  return crypto.subtle.importKey("raw", asArrayBuffer(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptToken(
  token: string,
  keyConfig: string,
  associatedData: string,
): Promise<EncryptedToken> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(iv),
      additionalData: new TextEncoder().encode(associatedData),
    },
    await keyFromConfig(keyConfig),
    new TextEncoder().encode(token),
  );
  return EncryptedTokenSchema.parse({ ciphertext: encode(new Uint8Array(ciphertext)), iv: encode(iv) });
}

export async function decryptToken(
  token: EncryptedToken,
  keyConfig: string,
  associatedData: string,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(decode(token.iv)),
      additionalData: new TextEncoder().encode(associatedData),
    },
    await keyFromConfig(keyConfig),
    asArrayBuffer(decode(token.ciphertext)),
  );
  return new TextDecoder().decode(plaintext);
}

// Bind a stored connection secret to its tenant and connection. A ciphertext
// copied to another organization, connection, or name will fail decryption.
export function connectionSecretAssociatedData(
  organizationId: string,
  connectionId: string,
  secretName: string,
): string {
  return `flary:connection-secret:${organizationId}:${connectionId}:${secretName}`;
}

export function providerCredentialAssociatedData(
  organizationId: string,
  userId: string,
  connectionId: string,
  provider: string,
  secretName: string,
): string {
  return [
    "flary:provider-credential",
    organizationId,
    userId,
    connectionId,
    provider,
    secretName,
  ].join(":");
}

export function providerOAuthStateAssociatedData(
  organizationId: string,
  userId: string,
  appId: string,
  sessionId: string,
): string {
  return [
    "flary:provider-oauth-state",
    organizationId,
    userId,
    appId,
    sessionId,
  ].join(":");
}

export function hashOAuthState(value: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then((digest) => encode(new Uint8Array(digest)));
}

/** Create a Worker-internal capability bound to one Flue resource. */
export function internalRequestToken(
  secret: string,
  resource: string,
): Promise<string> {
  return hashOAuthState(`flary:internal:${secret}:${resource}`);
}
