import type { JsonValue } from "../contracts/common.js";

const SENSITIVE_KEY =
  /(authorization|api[-_]?key|access[-_]?token|credential|cookie|password|private[-_]?key|secret|session[-_]?token|token)/i;
const SENSITIVE_PREFIX =
  /^(?:bearer\s+|basic\s+|sk-[A-Za-z0-9]|gh[pousr]_[A-Za-z0-9]|xox[baprs]-|AKIA[0-9A-Z])/i;
const SENSITIVE_ASSIGNMENT =
  /((?:authorization|api[-_]?key|access[-_]?token|credential|cookie|password|private[-_]?key|secret|session[-_]?token|token)\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s,;}\]"']+/gi;
const SENSITIVE_TOKEN =
  /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}|gh[pousr]_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})\b/g;

/**
 * Remove common credential values from data that is sent to events or logs.
 * This function is for observability data. It is not an encryption boundary.
 */
export function redactSecrets(value: unknown, key?: string): JsonValue {
  if (key && SENSITIVE_KEY.test(key)) return "<redacted>";
  if (typeof value === "string") {
    return redactText(value);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => [
        name,
        redactSecrets(item, name),
      ]),
    );
  }
  return "<redacted>";
}

export function redactText(value: string): string {
  if (SENSITIVE_PREFIX.test(value.trim())) return "<redacted>";
  return value
    .replace(SENSITIVE_ASSIGNMENT, "$1<redacted>")
    .replace(SENSITIVE_TOKEN, "<redacted>");
}

export function redactErrorMessage(value: unknown, fallback: string): string {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : typeof value === "object" && value !== null && "message" in value
          ? String((value as { message: unknown }).message)
          : fallback;
  return redactText(message);
}
