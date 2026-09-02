import { parseDocument } from "yaml";
import { diagnosticFromZod, makeDiagnostic, throwCompileError } from "./diagnostics.js";
import { PromptFrontmatterSchema, type PromptFrontmatter } from "./types.js";

export interface ParsedPromptDocument {
  frontmatter: PromptFrontmatter;
  body: string;
}

export function parsePromptDocument(source: string, file?: string): ParsedPromptDocument {
  if (!source.startsWith("---")) {
    return {
      frontmatter: PromptFrontmatterSchema.parse({}),
      body: source,
    };
  }

  const firstLineEnd = source.indexOf("\n");
  if (firstLineEnd < 0 || source.slice(0, firstLineEnd).trim() !== "---") {
    return {
      frontmatter: PromptFrontmatterSchema.parse({}),
      body: source,
    };
  }

  const closingMatch = /^---\s*$/m.exec(source.slice(firstLineEnd + 1));
  if (!closingMatch) {
    throwCompileError(
      makeDiagnostic({
        code: "UNCLOSED_FRONTMATTER",
        file,
        line: 1,
        message: "Prompt frontmatter needs a closing --- line.",
      }),
    );
  }

  const yamlStart = firstLineEnd + 1;
  const yamlEnd = yamlStart + closingMatch.index;
  const bodyStart = yamlEnd + closingMatch[0].length;
  const yamlText = source.slice(yamlStart, yamlEnd);
  const body = source.slice(bodyStart).replace(/^\r?\n/, "");
  const document = parseDocument(yamlText, {
    merge: false,
    prettyErrors: false,
    uniqueKeys: true,
  });

  if (document.errors.length > 0) {
    throwCompileError(
      document.errors.map((error) =>
        makeDiagnostic({
          code: "INVALID_YAML",
          file,
          message: error.message,
        }),
      ),
    );
  }

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throwCompileError(
      makeDiagnostic({
        code: "UNSAFE_YAML",
        file,
        message: "YAML aliases and executable values are not allowed.",
      }),
      error,
    );
  }

  const parsed = PromptFrontmatterSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throwCompileError(
      diagnosticFromZod(parsed.error, {
        code: "INVALID_FRONTMATTER",
        file,
      }),
    );
  }

  return { frontmatter: parsed.data, body };
}
