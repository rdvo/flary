import {
  SessionJsonValueSchema,
  SessionRecordDraftSchema,
  SessionRecordSchema,
  type SessionJsonValue,
  type SessionRecord,
  type SessionRecordDraft,
} from "./contracts.js";

export class SessionIntegrityError extends Error {
  readonly sequence?: number;

  constructor(message: string, sequence?: number) {
    super(message);
    this.name = "SessionIntegrityError";
    this.sequence = sequence;
  }
}

function sortJson(value: SessionJsonValue): SessionJsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, SessionJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJson(value[key]!);
    }
    return sorted;
  }
  return value;
}

/** Return stable JSON for record hashes and JSONL exports. */
export function canonicalSessionJson(value: unknown): string {
  return JSON.stringify(sortJson(SessionJsonValueSchema.parse(value)));
}

export async function sessionSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sealSessionRecord(
  draftInput: SessionRecordDraft,
  sequence: number,
  previousHash: string | null,
): Promise<SessionRecord> {
  const draft = SessionRecordDraftSchema.parse(draftInput);
  const unsigned = {
    ...draft,
    sequence,
    previousHash,
  };
  return SessionRecordSchema.parse({
    ...unsigned,
    recordHash: await sessionSha256(canonicalSessionJson(unsigned)),
  });
}

export async function verifySessionRecord(recordInput: SessionRecord): Promise<boolean> {
  const record = SessionRecordSchema.parse(recordInput);
  const { recordHash, ...unsigned } = record;
  return recordHash === (await sessionSha256(canonicalSessionJson(unsigned)));
}

export interface SessionChainOptions {
  firstSequence?: number;
  previousHash?: string | null;
}

/** Verify record hashes, sequence order, and links for one session. */
export async function verifySessionChain(
  recordsInput: readonly SessionRecord[],
  options: SessionChainOptions = {},
): Promise<void> {
  if (recordsInput.length === 0) return;
  const records = recordsInput.map((record) => SessionRecordSchema.parse(record));
  const sessionId = records[0]!.sessionId;
  const tenantId = records[0]!.tenantId;
  const applicationId = records[0]!.applicationId;
  let expectedSequence = options.firstSequence ?? 1;
  let previousHash = options.previousHash ?? null;

  for (const record of records) {
    if (
      record.sessionId !== sessionId ||
      record.tenantId !== tenantId ||
      record.applicationId !== applicationId
    ) {
      throw new SessionIntegrityError(
        "A session chain cannot contain records from a different scope",
        record.sequence,
      );
    }
    if (record.sequence !== expectedSequence) {
      throw new SessionIntegrityError(
        `Expected sequence ${expectedSequence}, received ${record.sequence}`,
        record.sequence,
      );
    }
    if (record.previousHash !== previousHash) {
      throw new SessionIntegrityError(
        `The previous hash does not match at sequence ${record.sequence}`,
        record.sequence,
      );
    }
    if (!(await verifySessionRecord(record))) {
      throw new SessionIntegrityError(
        `The record hash does not match at sequence ${record.sequence}`,
        record.sequence,
      );
    }
    expectedSequence += 1;
    previousHash = record.recordHash;
  }
}
