import { z } from "zod";

import { SessionSha256Schema } from "./contracts.js";

export interface CanonicalArchiveBucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete?(key: string): Promise<void>;
}

/** Public metadata for one encrypted canonical archive segment. */
export const CanonicalArchiveEntrySchema = z
  .object({
    sessionId: z.string().min(1),
    storageKey: z.string().min(1),
    sha256: SessionSha256Schema,
    size: z.number().int().nonnegative(),
    nonceBase64: z.string().min(1),
    keyVersion: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type CanonicalArchiveEntry = z.infer<typeof CanonicalArchiveEntrySchema>;

/**
 * Store complete Flue records and private provider pins outside the public
 * ledger. The object is encrypted before it reaches R2. Callers only receive
 * a verified manifest and must use an authenticated host to read it.
 */
export class R2CanonicalSessionArchive {
  readonly #bucket: CanonicalArchiveBucket;
  readonly #secret: string;
  readonly #keyVersion: string;

  constructor(input: {
    readonly bucket: CanonicalArchiveBucket;
    readonly secret: string;
    readonly keyVersion?: string;
  }) {
    if (input.secret.length < 32) {
      throw new Error("The canonical session archive key must have at least 32 characters");
    }
    this.#bucket = input.bucket;
    this.#secret = input.secret;
    this.#keyVersion = input.keyVersion ?? "v1";
  }

  async put(
    sessionId: string,
    content: string | Uint8Array,
    suffix = "jsonl",
  ): Promise<CanonicalArchiveEntry> {
    const plaintext = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const compressed = await gzip(plaintext);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(this.#secret);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: arrayBuffer(nonce),
          additionalData: arrayBuffer(new TextEncoder().encode(`${sessionId}:${this.#keyVersion}`)),
        },
        key,
        arrayBuffer(compressed),
      ),
    );
    const digest = await sha256(ciphertext);
    const storageKey = `canonical-sessions/${encodeURIComponent(sessionId)}/${Date.now()}-${digest}.${suffix}.gz.aes`;
    await this.#bucket.put(storageKey, ciphertext, {
      customMetadata: {
        sessionId,
        sha256: digest,
        keyVersion: this.#keyVersion,
        encoding: "gzip+aes-256-gcm",
      },
    });
    return CanonicalArchiveEntrySchema.parse({
      sessionId,
      storageKey,
      sha256: digest,
      size: ciphertext.byteLength,
      nonceBase64: bytesToBase64(nonce),
      keyVersion: this.#keyVersion,
      createdAt: new Date().toISOString(),
    });
  }

  async read(entryInput: CanonicalArchiveEntry): Promise<Uint8Array> {
    const entry = CanonicalArchiveEntrySchema.parse(entryInput);
    const object = await this.#bucket.get(entry.storageKey);
    if (!object) throw new Error(`Canonical archive '${entry.storageKey}' is missing`);
    const ciphertext = new Uint8Array(await object.arrayBuffer());
    if ((await sha256(ciphertext)) !== entry.sha256) {
      throw new Error(`Canonical archive '${entry.storageKey}' failed its hash check`);
    }
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: arrayBuffer(base64ToBytes(entry.nonceBase64)),
        additionalData: arrayBuffer(
          new TextEncoder().encode(`${entry.sessionId}:${entry.keyVersion}`),
        ),
      },
      await deriveKey(this.#secret),
      arrayBuffer(ciphertext),
    );
    return gunzip(new Uint8Array(plaintext));
  }

  async delete(entryInput: CanonicalArchiveEntry): Promise<void> {
    const entry = CanonicalArchiveEntrySchema.parse(entryInput);
    await this.#bucket.delete?.(entry.storageKey);
  }
}

interface CanonicalArchiveSqlRows<T> {
  toArray(): T[];
}

interface CanonicalArchiveSql {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): CanonicalArchiveSqlRows<T>;
}

interface CanonicalArchiveManifestRow {
  archive_id: number;
  session_id: string;
  kind: string;
  entry_json: string;
}

/**
 * Durable manifest for encrypted canonical snapshots.
 *
 * R2 stores the bytes. Durable Object SQLite stores only the verified object
 * manifest, so a restart can list, restore, and delete a session without
 * scanning an R2 bucket.
 */
export class SqliteCanonicalSessionArchive {
  readonly #sql: CanonicalArchiveSql;
  readonly #archive: R2CanonicalSessionArchive;

  constructor(input: {
    readonly sql: unknown;
    readonly bucket: CanonicalArchiveBucket;
    readonly secret: string;
    readonly keyVersion?: string;
  }) {
    const sql = input.sql as Partial<CanonicalArchiveSql>;
    if (typeof sql.exec !== "function") {
      throw new Error("The canonical session archive needs Durable Object SQLite");
    }
    this.#sql = sql as CanonicalArchiveSql;
    this.#archive = new R2CanonicalSessionArchive(input);
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS flary_canonical_session_archives (
        archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flary_canonical_session_archives_session
      ON flary_canonical_session_archives (session_id, archive_id);
    `);
  }

  async append(
    sessionId: string,
    content: string | Uint8Array,
    kind = "flue.snapshot",
  ): Promise<CanonicalArchiveEntry> {
    const entry = await this.#archive.put(sessionId, content);
    this.#sql.exec(
      `INSERT INTO flary_canonical_session_archives
        (session_id, kind, entry_json, created_at)
       VALUES (?, ?, ?, ?)`,
      sessionId,
      kind,
      JSON.stringify(entry),
      entry.createdAt,
    );
    return entry;
  }

  async list(sessionId: string): Promise<readonly CanonicalArchiveEntry[]> {
    return this.#sql
      .exec<CanonicalArchiveManifestRow>(
        `SELECT archive_id, session_id, kind, entry_json
       FROM flary_canonical_session_archives
       WHERE session_id = ? ORDER BY archive_id ASC`,
        sessionId,
      )
      .toArray()
      .map((row) => CanonicalArchiveEntrySchema.parse(JSON.parse(row.entry_json)));
  }

  async read(sessionId: string): Promise<Uint8Array[]> {
    const entries = await this.list(sessionId);
    const output: Uint8Array[] = [];
    for (const entry of entries) output.push(await this.#archive.read(entry));
    return output;
  }

  async deleteSession(sessionId: string): Promise<number> {
    const rows = this.#sql
      .exec<CanonicalArchiveManifestRow>(
        `SELECT archive_id, session_id, kind, entry_json
       FROM flary_canonical_session_archives
       WHERE session_id = ? ORDER BY archive_id ASC`,
        sessionId,
      )
      .toArray();
    for (const row of rows) {
      await this.#archive.delete(CanonicalArchiveEntrySchema.parse(JSON.parse(row.entry_json)));
    }
    this.#sql.exec("DELETE FROM flary_canonical_session_archives WHERE session_id = ?", sessionId);
    return rows.length;
  }
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") return bytes;
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  await writer.write(bytes as unknown as BufferSource);
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") return bytes;
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  await writer.write(bytes as unknown as BufferSource);
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let value = "";
    for (const byte of bytes) value += String.fromCharCode(byte);
    return btoa(value);
  }
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof atob === "function") {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
