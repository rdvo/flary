import type { FlaryToolRegistry } from "./types.js";

const WORKSPACE_READS = [
  "list",
  "stat",
  "glob",
  "grep",
  "read",
  "diff",
] as const;
const WORKSPACE_WRITES = [
  "write",
  "edit",
  "batchEdit",
  "move",
  "delete",
] as const;

/**
 * Give the model stable knowledge of small, built-in tool surfaces without
 * loading their full JSON Schemas into every provider request.
 */
export function coreToolGuidance(
  registry: FlaryToolRegistry | undefined
): string {
  if (!registry) return "";
  const groups: string[] = [];
  const localToolIds: string[] = [];
  for (const namespace of registry.names) {
    const source = registry.entries[namespace];
    if (!source) continue;
    if (typeof source === "function") {
      localToolIds.push(namespace);
      continue;
    }
    if (source.kind === "workspace") {
      groups.push(
        `${namespace}: ${[...WORKSPACE_READS, ...WORKSPACE_WRITES]
          .map((name) => `${namespace}.${name}`)
          .join(", ")}, and ${namespace}.git_*`
      );
    } else if (source.kind === "sandbox") {
      groups.push(
        `${namespace}: ${namespace}.exec and durable ${namespace}.process* controls`
      );
    } else if (source.kind === "browser") {
      groups.push(
        `${namespace}: navigation, page inspection, input, screenshots, downloads, and session control`
      );
    } else if (source.kind === "r2") {
      groups.push(
        `${namespace}: tenant-scoped R2 file list, stat, glob, grep, read, diff, write, edit, move, and delete`
      );
    }
  }
  if (localToolIds.length > 0) {
    groups.push(`application tools: ${localToolIds.join(", ")}`);
  }
  if (groups.length === 0) {
    return "Search the private catalog for available tools. Load a selected tool schema with tools.describe before you call it.";
  }
  return [
    `Core tool names and purposes are already known: ${groups.join("; ")}.`,
    "Load a selected input schema with tools.describe before you call it.",
    "Pass the exact catalog id or a selected item's id value to tools.call. Never pass a variable name as a quoted id.",
    "Use tools.search for MCP, OpenAPI, local, skill, and uncommon tools.",
  ].join(" ");
}

/** Description for the one provider-visible tool. */
export function executeToolDescription(
  registry: FlaryToolRegistry | undefined
): string {
  return [
    "Run bounded TypeScript in Flary's isolated tool runtime.",
    "Use tools.search, tools.describe, tools.call, and tools.batch.",
    coreToolGuidance(registry),
  ]
    .filter(Boolean)
    .join(" ");
}
