import { makeDiagnostic, throwCompileError } from "./diagnostics.js";
import type { PromptInputDefinition } from "./types.js";

const TEMPLATE_VALUE = /{{\s*([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)\s*}}/g;
const UNSAFE_TEMPLATE = /{{[{#/!>^&]|}}}/;
const SECRET_SEGMENTS = new Set(["secret", "secrets", "token", "apikey", "api_key", "password"]);

export function findTemplatePaths(template: string, file?: string): string[] {
  if (UNSAFE_TEMPLATE.test(template)) {
    throwCompileError(
      makeDiagnostic({
        code: "UNSAFE_TEMPLATE",
        file,
        message: "Only simple {{value.path}} placeholders are allowed.",
      }),
    );
  }

  const paths = new Set<string>();
  for (const match of template.matchAll(TEMPLATE_VALUE)) {
    const path = match[1];
    if (path.split(".").some((segment) => SECRET_SEGMENTS.has(segment.toLowerCase()))) {
      throwCompileError(
        makeDiagnostic({
          code: "SECRET_INTERPOLATION",
          file,
          message: `Secret-like value '${path}' cannot be inserted into a prompt.`,
        }),
      );
    }
    paths.add(path);
  }
  return [...paths].sort();
}

export function renderPromptTemplate(
  template: string,
  values: Record<string, unknown>,
  definitions: Record<string, PromptInputDefinition>,
  file?: string,
): string {
  rejectUnknownValues(values, definitions, file);

  for (const definition of Object.values(definitions)) {
    const found = readPath(values, definition.path);
    if (!found.exists) {
      if (definition.required) {
        throwCompileError(
          makeDiagnostic({
            code: "MISSING_INPUT",
            file,
            message: `Required prompt input '${definition.path}' is missing.`,
          }),
        );
      }
      continue;
    }
    assertValueType(definition, found.value, file);
  }

  return template.replace(TEMPLATE_VALUE, (_match, path: string) => {
    const found = readPath(values, path);
    if (!found.exists) return "";
    return formatValue(found.value);
  });
}

function readPath(
  value: Record<string, unknown>,
  path: string,
): { exists: boolean; value?: unknown } {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return { exists: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}

function rejectUnknownValues(
  values: Record<string, unknown>,
  definitions: Record<string, PromptInputDefinition>,
  file?: string,
): void {
  const allowedRoots = new Set(Object.keys(definitions).map((path) => path.split(".")[0]));
  const unknown = Object.keys(values).filter((key) => !allowedRoots.has(key));
  if (unknown.length > 0) {
    throwCompileError(
      makeDiagnostic({
        code: "UNKNOWN_INPUT",
        file,
        message: `Unknown prompt input${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
      }),
    );
  }
}

function assertValueType(definition: PromptInputDefinition, value: unknown, file?: string): void {
  const matches =
    definition.type === "any" ||
    definition.type === "json" ||
    (definition.type === "array"
      ? Array.isArray(value)
      : definition.type === "object"
        ? value !== null && typeof value === "object" && !Array.isArray(value)
        : typeof value === definition.type);

  if (!matches) {
    throwCompileError(
      makeDiagnostic({
        code: "INVALID_INPUT_TYPE",
        file,
        message: `Prompt input '${definition.path}' must be ${definition.type}.`,
      }),
    );
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2);
}
