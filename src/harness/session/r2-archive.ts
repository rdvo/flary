import {
  SessionRecordSchema,
  type SessionRecord,
} from "./contracts.js";
import { SqliteSessionLedger } from "./sqlite.js";

interface SqlRows<T> {
  toArray(): T[];
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlRows<T>;
  transactionSync<T>(closure: () => T): T;
}

interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SessionArchiveBucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete?(key: string): Promise<void>;
}

interface ArchiveSegmentRow {
  storage_key: string;
  first_sequence: number;
  last_sequence: number;
  nonce_base64: string;
  sha256: string;
}

/** Seal cold session records as gzip-compressed, AES-GCM-encrypted R2 data. */
export class R2SessionArchive {
  readonly #sql: SqlStorage;
  readonly #bucket: SessionArchiveBucket;
  readonly #secret: string;

  constructor(input: {
    readonly sql: unknown;
    readonly bucket: SessionArchiveBucket;
    readonly secret: string;
  }) {
    const sql = input.sql as Partial<SqlStorage>;
    if (
      typeof sql.exec !== "function" ||
      typeof sql.transactionSync !== "function"
    ) {
      throw new Error("The R2 session archive needs Durable Object SQLite");
    }
    if (input.secret.length < 32) {
      throw new Error("FLARY_SESSION_ARCHIVE_KEY must have at least 32 characters");
    }
    this.#sql = sql as SqlStorage;
    this.#bucket = input.bucket;
    this.#secret = input.secret;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS flary_session_archive_segments (
        session_id TEXT NOT NULL,
        first_sequence INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL,
        storage_key TEXT NOT NULL,
        nonce_base64 TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        record_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, first_sequence),
        UNIQUE (storage_key)
      );
    `);
  }

  async sealColdRecords(sessionId: string): Promise<number> {
    const ledger = new SqliteSessionLedger(this.#sql);
    const metadata = await ledger.metadata(sessionId);
    if (!metadata?.archiveRequired) return 0;
    const lastSequence = metadata.latestSequence - metadata.hotRecordLimit;
    const rows = this.#sql.exec<{ record_json: string }>(
      `SELECT record_json
       FROM flary_session_ledger_records
       WHERE session_id = ? AND sequence > ? AND sequence <= ?
       ORDER BY sequence ASC`,
      sessionId,
      metadata.sealedThroughSequence,
      lastSequence,
    ).toArray();
    if (rows.length === 0) return 0;
    const records = rows.map((row) =>
      SessionRecordSchema.parse(JSON.parse(row.record_json)));
    const firstSequence = records[0]!.sequence;
    const plaintext = new TextEncoder().encode(
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const compressed = await gzip(plaintext);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await archiveKey(this.#secret);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: arrayBuffer(nonce),
          additionalData: new TextEncoder().encode(
            `${sessionId}:${firstSequence}:${lastSequence}`,
          ),
        },
        key,
        arrayBuffer(compressed),
      ),
    );
    const digest = await sha256(ciphertext);
    const storageKey =
      `sessions/${encodeURIComponent(sessionId)}/` +
      `${firstSequence}-${lastSequence}-${digest}.jsonl.gz.aes`;
    await this.#bucket.put(storageKey, ciphertext, {
      customMetadata: {
        sessionId,
        firstSequence: String(firstSequence),
        lastSequence: String(lastSequence),
        sha256: digest,
        encoding: "gzip+aes-256-gcm",
      },
    });
    this.#sql.transactionSync(() => {
      this.#sql.exec(
        `INSERT INTO flary_session_archive_segments (
           session_id, first_sequence, last_sequence, storage_key,
           nonce_base64, sha256, record_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        sessionId,
        firstSequence,
        lastSequence,
        storageKey,
        bytesToBase64(nonce),
        digest,
        records.length,
        new Date().toISOString(),
      );
      this.#sql.exec(
        `DELETE FROM flary_session_ledger_records
         WHERE session_id = ? AND sequence >= ? AND sequence <= ?`,
        sessionId,
        firstSequence,
        lastSequence,
      );
    });
    await ledger.markSealedThrough(sessionId, lastSequence);
    return records.length;
  }

  async read(
    sessionId: string,
    options: { readonly after?: number; readonly limit?: number } = {},
  ): Promise<SessionRecord[]> {
    const after = options.after ?? 0;
    const limit = options.limit ?? 1_000;
    const segments = this.#sql.exec<ArchiveSegmentRow>(
      `SELECT storage_key, first_sequence, last_sequence, nonce_base64, sha256
       FROM flary_session_archive_segments
       WHERE session_id = ? AND last_sequence > ?
       ORDER BY first_sequence ASC`,
      sessionId,
      after,
    ).toArray();
    const records: SessionRecord[] = [];
    const key = await archiveKey(this.#secret);
    for (const segment of segments) {
      const object = await this.#bucket.get(segment.storage_key);
      if (!object) throw new Error(`Session archive '${segment.storage_key}' is missing`);
      const ciphertext = new Uint8Array(await object.arrayBuffer());
      if (await sha256(ciphertext) !== segment.sha256) {
        throw new Error(`Session archive '${segment.storage_key}' failed its hash check`);
      }
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: arrayBuffer(base64ToBytes(segment.nonce_base64)),
          additionalData: new TextEncoder().encode(
            `${sessionId}:${segment.first_sequence}:${segment.last_sequence}`,
          ),
        },
        key,
        arrayBuffer(ciphertext),
      );
      const text = new TextDecoder().decode(
        await gunzip(new Uint8Array(plaintext)),
      );
      for (const line of text.split("\n")) {
        if (!line) continue;
        const record = SessionRecordSchema.parse(JSON.parse(line));
        if (record.sequence > after) records.push(record);
        if (records.length >= limit) return records;
      }
    }
    return records;
  }

  /** Delete all sealed public ledger segments for one session. */
  async deleteSession(sessionId: string): Promise<number> {
    const segments = this.#sql.exec<{ storage_key: string }>(
      "SELECT storage_key FROM flary_session_archive_segments WHERE session_id = ?",
      sessionId,
    ).toArray();
    for (const segment of segments) await this.#bucket.delete?.(segment.storage_key);
    this.#sql.exec(
      "DELETE FROM flary_session_archive_segments WHERE session_id = ?",
      sessionId,
    );
    return segments.length;
  }
}

async function archiveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") return bytes;
  return transform(bytes, new CompressionStream("gzip"));
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") return bytes;
  return transform(bytes, new DecompressionStream("gzip"));
}

async function transform(
  bytes: Uint8Array,
  stream: TransformStream<BufferSource, Uint8Array>,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  await writer.write(Uint8Array.from(bytes));
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", arrayBuffer(bytes)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
