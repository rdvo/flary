import {
  JsonValueSchema,
  StorageRecordSchema,
  type JsonValue,
  type StorageRecord,
} from "./records.js";

export class JsonlParseError extends Error {
  readonly lineNumber: number;

  constructor(lineNumber: number, message: string) {
    super(`Invalid JSONL at line ${lineNumber}: ${message}`);
    this.name = "JsonlParseError";
    this.lineNumber = lineNumber;
  }
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value !== null && typeof value === "object") {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue(value[key]);
    }
    return sorted;
  }

  return value;
}

function canonicalJson(value: unknown): string {
  const parsed = JsonValueSchema.parse(value);
  return JSON.stringify(sortJsonValue(parsed));
}

/** Encodes canonical records as one stable JSON object per line. */
export function exportJsonl(records: Iterable<StorageRecord>): string {
  let output = "";

  for (const record of records) {
    const canonicalRecord = StorageRecordSchema.parse(record);
    output += `${canonicalJson(canonicalRecord)}\n`;
  }

  return output;
}

export const toJsonl = exportJsonl;
export const exportRecordsJsonl = exportJsonl;

/** Parses JSONL and validates every non-empty line as a canonical record. */
export function importJsonl(input: string): StorageRecord[] {
  const records: StorageRecord[] = [];
  const lines = input.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0) {
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid JSON";
      throw new JsonlParseError(index + 1, message);
    }

    const parsed = StorageRecordSchema.safeParse(value);
    if (!parsed.success) {
      throw new JsonlParseError(index + 1, parsed.error.message);
    }

    records.push(parsed.data);
  }

  return records;
}

export const fromJsonl = importJsonl;
export const importRecordsJsonl = importJsonl;

/**
 * Reads line fragments from a sync or async source without requiring a file
 * system or a platform stream implementation.
 */
export async function* importJsonlLines(
  chunks: Iterable<string> | AsyncIterable<string>,
): AsyncGenerator<StorageRecord> {
  let buffer = "";
  let lineNumber = 0;

  for await (const chunk of chunks) {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      lineNumber += 1;
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      let value: unknown;
      try {
        value = JSON.parse(trimmed) as unknown;
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid JSON";
        throw new JsonlParseError(lineNumber, message);
      }

      const parsed = StorageRecordSchema.safeParse(value);
      if (!parsed.success) {
        throw new JsonlParseError(lineNumber, parsed.error.message);
      }

      yield parsed.data;
    }
  }

  if (buffer.trim().length > 0) {
    lineNumber += 1;
    let value: unknown;
    try {
      value = JSON.parse(buffer.trim()) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid JSON";
      throw new JsonlParseError(lineNumber, message);
    }

    const parsed = StorageRecordSchema.safeParse(value);
    if (!parsed.success) {
      throw new JsonlParseError(lineNumber, parsed.error.message);
    }

    yield parsed.data;
  }
}
