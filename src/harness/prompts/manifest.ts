import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { compilePrompt } from "./compiler.js";
import type {
  PromptCompileOptions,
  PromptManifest,
  PromptSource,
} from "./types.js";

export async function buildPromptManifest(
  sources: readonly PromptSource[],
  options: PromptCompileOptions = {},
): Promise<PromptManifest> {
  const compiled = await Promise.all(
    sources.map((source) => compilePrompt(source, options)),
  );
  const prompts: PromptManifest["prompts"] = {};

  for (const prompt of compiled.sort((left, right) =>
    left.slug.localeCompare(right.slug),
  )) {
    if (prompts[prompt.slug]) {
      throw new Error(`Duplicate prompt slug '${prompt.slug}'.`);
    }
    prompts[prompt.slug] = prompt;
  }
  return { version: 1, prompts };
}

export async function loadPromptSources(directory: string): Promise<PromptSource[]> {
  const sources: PromptSource[] = [];
  await walk(directory, sources);
  return sources.sort((left, right) => left.path.localeCompare(right.path));
}

export async function buildPromptManifestFromDirectory(
  directory: string,
  options: Omit<PromptCompileOptions, "rootDir"> = {},
): Promise<PromptManifest> {
  return buildPromptManifest(await loadPromptSources(directory), {
    ...options,
    rootDir: directory,
  });
}

async function walk(directory: string, sources: PromptSource[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path, sources);
      } else if (entry.isFile() && entry.name.endsWith(".prompt.md")) {
        sources.push({ path, content: await readFile(path, "utf8") });
      }
    }),
  );
}
