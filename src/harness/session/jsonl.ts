import {
  SessionRecordSchema,
  type SessionRecord,
} from "./contracts.js";
import {
  canonicalSessionJson,
  verifySessionChain,
} from "./integrity.js";

export class SessionJsonlError extends Error {
  readonly lineNumber: number;

  constructor(lineNumber: number, message: string) {
    super(`Invalid flary-jsonl at line ${lineNumber}: ${message}`);
    this.name = "SessionJsonlError";
    this.lineNumber = lineNumber;
  }
}

/** Export one canonical session record on each line. */
export function exportSessionJsonl(records: Iterable<SessionRecord>): string {
  let output = "";
  for (const recordInput of records) {
    output += `${canonicalSessionJson(SessionRecordSchema.parse(recordInput))}\n`;
  }
  return output;
}

/** Stream a verified JSONL export without building one large string. */
export function streamSessionJsonl(
  records: Iterable<SessionRecord> | AsyncIterable<SessionRecord>,
): ReadableStream<Uint8Array> {
  const iterator = Symbol.asyncIterator in Object(records)
    ? (records as AsyncIterable<SessionRecord>)[Symbol.asyncIterator]()
    : (async function* () {
        yield* records as Iterable<SessionRecord>;
      })();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${canonicalSessionJson(SessionRecordSchema.parse(next.value))}\n`));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/** Import and verify a complete session chain. */
export async function importSessionJsonl(input: string): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  for (const [index, source] of input.split(/\r?\n/).entries()) {
    const line = source.trim();
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new SessionJsonlError(
        index + 1,
        error instanceof Error ? error.message : "Invalid JSON",
      );
    }
    const parsed = SessionRecordSchema.safeParse(value);
    if (!parsed.success) {
      throw new SessionJsonlError(index + 1, parsed.error.message);
    }
    records.push(parsed.data);
  }
  try {
    await verifySessionChain(records);
  } catch (error) {
    throw new SessionJsonlError(
      error instanceof Error &&
        "sequence" in error &&
        typeof error.sequence === "number"
        ? error.sequence
        : 1,
      error instanceof Error ? error.message : "The integrity chain is invalid",
    );
  }
  return records;
}
