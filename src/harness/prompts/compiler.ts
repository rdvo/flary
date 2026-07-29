import {
  PromptCompileOptionsSchema,
  PromptInputTypeSchema,
  PromptSourceSchema,
} from "./types.js";
import type {
  CompiledPrompt,
  PromptCompileOptions,
  PromptInputDefinition,
  PromptSource,
} from "./types.js";
import { parsePromptDocument } from "./frontmatter.js";
import { findTemplatePaths, renderPromptTemplate } from "./template.js";
import { makeDiagnostic, throwCompileError } from "./diagnostics.js";

export async function compilePrompt(
  sourceInput: PromptSource,
  optionsInput: PromptCompileOptions = {},
): Promise<CompiledPrompt> {
  const source = PromptSourceSchema.parse(sourceInput);
  const options = PromptCompileOptionsSchema.parse(optionsInput);
  const document = parsePromptDocument(source.content, source.path);
  const slug = promptSlugFromPath(source.path, options.rootDir);
  const placeholderPaths = findTemplatePaths(document.body, source.path);
  const definitions = normalizeInputDefinitions(
    document.frontmatter.input,
    placeholderPaths,
  );
  const rendered =
    options.values === undefined
      ? document.body
      : renderPromptTemplate(
          document.body,
          options.values,
          definitions,
          source.path,
        );
  const fixedModel =
    document.frontmatter.model === "inherit"
      ? undefined
      : document.frontmatter.model;
  const resolvedModel = fixedModel ?? options.callerModel;

  return {
    slug,
    path: source.path,
    name: document.frontmatter.name,
    description: document.frontmatter.description,
    modelMode: fixedModel ? "fixed" : "inherit",
    fixedModel,
    resolvedModel,
    thinking: document.frontmatter.thinking,
    profile: document.frontmatter.profile,
    tools: document.frontmatter.tools,
    limits: document.frontmatter.limits,
    template: document.body,
    rendered,
    inputs: definitions,
    sourceHash: await sha256(source.content),
    renderedHash: await sha256(rendered),
  };
}

export function promptSlugFromPath(path: string, rootDir?: string): string {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedRoot = rootDir?.replace(/\\/g, "/").replace(/\/+$/, "");
  let relative = normalizedPath;

  if (normalizedRoot && relative.startsWith(`${normalizedRoot}/`)) {
    relative = relative.slice(normalizedRoot.length + 1);
  } else if (relative.startsWith("/")) {
    relative = relative.slice(relative.lastIndexOf("/") + 1);
  }

  relative = relative.replace(/^prompts\//, "");
  if (!relative.endsWith(".prompt.md")) {
    throwCompileError(
      makeDiagnostic({
        code: "INVALID_PROMPT_PATH",
        file: path,
        message: "Prompt files must end with .prompt.md.",
      }),
    );
  }

  const slug = relative.slice(0, -".prompt.md".length);
  if (
    !slug ||
    slug.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throwCompileError(
      makeDiagnostic({
        code: "INVALID_PROMPT_SLUG",
        file: path,
        message: "Prompt path does not produce a safe slug.",
      }),
    );
  }
  return slug;
}

function normalizeInputDefinitions(
  declared: Record<string, string | {
    type?: "any" | "string" | "number" | "boolean" | "object" | "array" | "json";
    required?: boolean;
    description?: string;
  }>,
  placeholders: string[],
): Record<string, PromptInputDefinition> {
  const result: Record<string, PromptInputDefinition> = {};

  for (const [path, spec] of Object.entries(declared)) {
    result[path] =
      typeof spec === "string"
        ? {
            path,
            type: PromptInputTypeSchema.parse(spec),
            required: true,
          }
        : {
            path,
            type: spec.type ?? "any",
            required: spec.required ?? true,
            description: spec.description,
          };
  }

  for (const path of placeholders) {
    result[path] ??= { path, type: "any", required: true };
  }
  return result;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
