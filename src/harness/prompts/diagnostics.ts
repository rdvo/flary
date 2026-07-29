import { z } from "zod";

import {
  PromptDiagnostic,
  PromptDiagnosticSchema,
} from "./types";

export class PromptCompileError extends Error {
  readonly diagnostics: PromptDiagnostic[];

  constructor(
    diagnostics: PromptDiagnostic | PromptDiagnostic[],
    options?: { cause?: unknown }
  ) {
    const parsedDiagnostics = z
      .array(PromptDiagnosticSchema)
      .parse(Array.isArray(diagnostics) ? diagnostics : [diagnostics]);
    super(parsedDiagnostics.map(formatDiagnostic).join("\n"));
    this.name = "PromptCompileError";
    this.diagnostics = parsedDiagnostics;

    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: false,
      });
    }
  }
}

/** Backwards-compatible descriptive alias for callers that prefer this name. */
export { PromptCompileError as PromptCompilationError };

export function makeDiagnostic(
  diagnostic: Omit<PromptDiagnostic, "severity"> &
    Partial<Pick<PromptDiagnostic, "severity">>
): PromptDiagnostic {
  return PromptDiagnosticSchema.parse({
    severity: "error",
    ...diagnostic,
  });
}

export function formatDiagnostic(diagnostic: PromptDiagnostic): string {
  const location = diagnostic.file
    ? `${diagnostic.file}${
        diagnostic.line === undefined ? "" : `:${diagnostic.line}`
      }${
        diagnostic.column === undefined ? "" : `:${diagnostic.column}`
      }`
    : undefined;
  const prefix = location
    ? `${location} [${diagnostic.code}]`
    : `[${diagnostic.code}]`;
  return `${prefix} ${diagnostic.message}`;
}

export function throwCompileError(
  diagnostics: PromptDiagnostic | PromptDiagnostic[],
  cause?: unknown
): never {
  throw new PromptCompileError(diagnostics, { cause });
}

export function diagnosticFromZod(
  error: z.ZodError,
  options: { code?: string; file?: string; prefix?: string } = {}
): PromptDiagnostic[] {
  const code = options.code ?? "INVALID_ARGUMENT";
  return error.issues.map((issue) => {
    const issuePath = issue.path.length > 0 ? ` (${issue.path.join(".")})` : "";
    const prefix = options.prefix ? `${options.prefix}: ` : "";
    return makeDiagnostic({
      code,
      file: options.file,
      message: `${prefix}${issue.message}${issuePath}`,
    });
  });
}

export function throwZodBoundaryError(
  error: unknown,
  options: { code?: string; file?: string; prefix?: string } = {}
): never {
  if (error instanceof z.ZodError) {
    throwCompileError(diagnosticFromZod(error, options), error);
  }

  throw error;
}
