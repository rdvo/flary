import {
  AES_256_GCM_ALGORITHM,
  EncryptedEnvelopeSchema,
  type Aes256GcmKey,
  type EncryptedEnvelope,
  type EnvelopeDecryptOptions,
  type EnvelopeEncryptOptions,
  type EnvelopeEncryptor,
  type EnvelopeKeyProvider,
} from "./types.js";

export const AES_256_KEY_BYTES = 32;
export const AES_GCM_IV_BYTES = 12;
export const AES_GCM_TAG_BITS = 128;
const WEB_CRYPTO_AES_GCM = "AES-GCM";

export interface AesGcmCiphertext {
  readonly iv: Uint8Array;
  /** Web Crypto returns the authentication tag appended to this byte array. */
  readonly ciphertext: Uint8Array;
}

type CryptoGlobal = {
  crypto?: Crypto;
  btoa?: (value: string) => string;
  atob?: (value: string) => string;
  Buffer?: {
    from(value: string, encoding: string): { toString(encoding: string): string };
    from(value: Uint8Array): { toString(encoding: string): string };
  };
};

function getCrypto(): Crypto {
  const global = globalThis as typeof globalThis & CryptoGlobal;
  if (!global.crypto?.subtle || !global.crypto.getRandomValues) {
    throw new Error("Web Crypto with SubtleCrypto is required");
  }
  return global.crypto;
}

function copyBytes(value: Uint8Array): Uint8Array {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = copyBytes(value);
  return copy.buffer as ArrayBuffer;
}

function asBufferSource(value: Uint8Array): BufferSource {
  return asArrayBuffer(value);
}

function validateAes256KeyBytes(key: Uint8Array): Uint8Array {
  if (key.byteLength !== AES_256_KEY_BYTES) {
    throw new RangeError("AES-256-GCM requires a 32-byte key");
  }
  return key;
}

function validateIv(iv: Uint8Array): Uint8Array {
  if (iv.byteLength !== AES_GCM_IV_BYTES) {
    throw new RangeError("AES-GCM requires a 12-byte IV");
  }
  return iv;
}

function isCryptoKey(value: Uint8Array | Aes256GcmKey): value is Aes256GcmKey {
  return !(value instanceof Uint8Array);
}

async function resolveKey(key: Uint8Array | Aes256GcmKey): Promise<Aes256GcmKey> {
  if (isCryptoKey(key)) {
    return key;
  }
  return importAes256GcmKey(key);
}

export async function importAes256GcmKey(
  rawKey: Uint8Array,
  extractable = false,
): Promise<Aes256GcmKey> {
  const bytes = validateAes256KeyBytes(copyBytes(rawKey));
  return getCrypto().subtle.importKey(
    "raw",
    asBufferSource(bytes),
    { name: WEB_CRYPTO_AES_GCM },
    extractable,
    ["encrypt", "decrypt"],
  );
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError("Random byte length must be a non-negative integer");
  }
  const bytes = new Uint8Array(length);
  getCrypto().getRandomValues(bytes);
  return bytes;
}

export function randomAes256Key(): Uint8Array {
  return randomBytes(AES_256_KEY_BYTES);
}

export function randomAesGcmIv(): Uint8Array {
  return randomBytes(AES_GCM_IV_BYTES);
}

export async function encryptAes256Gcm(
  plaintext: Uint8Array,
  key: Uint8Array | Aes256GcmKey,
  options: { iv?: Uint8Array; additionalData?: Uint8Array } = {},
): Promise<AesGcmCiphertext> {
  const iv = validateIv(options.iv ? copyBytes(options.iv) : randomAesGcmIv());
  const cryptoKey = await resolveKey(key);
  const algorithm: AesGcmParams = {
    name: WEB_CRYPTO_AES_GCM,
    iv: asBufferSource(iv),
    tagLength: AES_GCM_TAG_BITS,
  };
  if (options.additionalData !== undefined) {
    algorithm.additionalData = asBufferSource(options.additionalData);
  }

  const ciphertext = await getCrypto().subtle.encrypt(
    algorithm,
    cryptoKey,
    asBufferSource(plaintext),
  );
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}

export async function decryptAes256Gcm(
  ciphertext: Uint8Array,
  key: Uint8Array | Aes256GcmKey,
  iv: Uint8Array,
  options: { additionalData?: Uint8Array } = {},
): Promise<Uint8Array> {
  const validatedIv = validateIv(copyBytes(iv));
  const cryptoKey = await resolveKey(key);
  const algorithm: AesGcmParams = {
    name: WEB_CRYPTO_AES_GCM,
    iv: asBufferSource(validatedIv),
    tagLength: AES_GCM_TAG_BITS,
  };
  if (options.additionalData !== undefined) {
    algorithm.additionalData = asBufferSource(options.additionalData);
  }

  const plaintext = await getCrypto().subtle.decrypt(
    algorithm,
    cryptoKey,
    asBufferSource(ciphertext),
  );
  return new Uint8Array(plaintext);
}

export const aes256GcmEncrypt = encryptAes256Gcm;
export const aes256GcmDecrypt = decryptAes256Gcm;

export async function encryptStringAes256Gcm(
  plaintext: string,
  key: Uint8Array | Aes256GcmKey,
  options: { iv?: Uint8Array; additionalData?: Uint8Array } = {},
): Promise<AesGcmCiphertext> {
  return encryptAes256Gcm(new TextEncoder().encode(plaintext), key, options);
}

export async function decryptStringAes256Gcm(
  ciphertext: Uint8Array,
  key: Uint8Array | Aes256GcmKey,
  iv: Uint8Array,
  options: { additionalData?: Uint8Array } = {},
): Promise<string> {
  const plaintext = await decryptAes256Gcm(ciphertext, key, iv, options);
  return new TextDecoder().decode(plaintext);
}

function base64Encode(bytes: Uint8Array): string {
  const global = globalThis as typeof globalThis & CryptoGlobal;
  if (global.btoa) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return global.btoa(binary);
  }

  if (global.Buffer) {
    return global.Buffer.from(bytes).toString("base64");
  }

  throw new Error("A base64 encoder is required");
}

function base64Decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid base64 data");
  }

  const global = globalThis as typeof globalThis & CryptoGlobal;
  if (global.atob) {
    const binary = global.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  if (global.Buffer) {
    const decoded = global.Buffer.from(value, "base64");
    const binary = decoded.toString("binary");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  throw new Error("A base64 decoder is required");
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url data");
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return base64Decode(padded);
}

export function encodeEncryptedEnvelopeBytes(
  value: AesGcmCiphertext,
): Pick<EncryptedEnvelope, "iv" | "ciphertext"> {
  return {
    iv: encodeBase64Url(value.iv),
    ciphertext: encodeBase64Url(value.ciphertext),
  };
}

export class Aes256GcmEnvelopeEncryptor implements EnvelopeEncryptor {
  private readonly keyProvider: EnvelopeKeyProvider;

  constructor(keyProvider: EnvelopeKeyProvider) {
    this.keyProvider = keyProvider;
  }

  async encrypt(
    plaintext: Uint8Array,
    options: EnvelopeEncryptOptions,
  ): Promise<EncryptedEnvelope> {
    const key = await this.keyProvider.getKey(options.keyId);
    if (key === undefined) {
      throw new Error(`Encryption key is not available: ${options.keyId}`);
    }

    const dataKeyBytes = randomAes256Key();
    const dataCiphertext = await encryptAes256Gcm(dataKeyBytes, key, {
      additionalData: new TextEncoder().encode(options.keyId),
    });
    const ciphertext = await encryptAes256Gcm(plaintext, dataKeyBytes, {
      additionalData: options.additionalData,
    });
    dataKeyBytes.fill(0);

    const envelope = EncryptedEnvelopeSchema.parse({
      schemaVersion: 1,
      algorithm: AES_256_GCM_ALGORITHM,
      keyId: options.keyId,
      ...encodeEncryptedEnvelopeBytes(ciphertext),
      wrappedKey: encodeBase64Url(dataCiphertext.ciphertext),
      wrappedKeyIv: encodeBase64Url(dataCiphertext.iv),
      additionalData:
        options.additionalData === undefined ? undefined : encodeBase64Url(options.additionalData),
    });
    return envelope;
  }

  async decrypt(
    envelopeInput: EncryptedEnvelope,
    options: EnvelopeDecryptOptions = {},
  ): Promise<Uint8Array> {
    const envelope = EncryptedEnvelopeSchema.parse(envelopeInput);
    const key = await this.keyProvider.getKey(envelope.keyId);
    if (key === undefined) {
      throw new Error(`Encryption key is not available: ${envelope.keyId}`);
    }
    if (envelope.wrappedKey === undefined || envelope.wrappedKeyIv === undefined) {
      throw new Error("Envelope does not contain a wrapped data key");
    }

    const dataKey = await decryptAes256Gcm(
      decodeBase64Url(envelope.wrappedKey),
      key,
      decodeBase64Url(envelope.wrappedKeyIv),
      { additionalData: new TextEncoder().encode(envelope.keyId) },
    );

    const expectedAdditionalData =
      options.additionalData ??
      (envelope.additionalData === undefined
        ? undefined
        : decodeBase64Url(envelope.additionalData));
    try {
      return await decryptAes256Gcm(
        decodeBase64Url(envelope.ciphertext),
        dataKey,
        decodeBase64Url(envelope.iv),
        { additionalData: expectedAdditionalData },
      );
    } finally {
      dataKey.fill(0);
    }
  }
}

export const WebCryptoEnvelopeEncryptor = Aes256GcmEnvelopeEncryptor;
