import { z } from "zod";
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
  registry: FlaryToolRegistry | undefined,
  eagerTools: readonly string[] = [],
): string {
  if (!registry) return "";
  const groups: string[] = [];
  const localToolIds = new Set<string>();
  for (const namespace of registry.names) {
    const source = registry.entries[namespace];
    if (!source) continue;
    if (typeof source === "function") {
      localToolIds.add(namespace);
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
  const eagerLocalToolIds = eagerTools.filter((id) => localToolIds.has(id));
  if (eagerLocalToolIds.length > 0) {
    groups.push(`eager application tools: ${eagerLocalToolIds.map((id) =>
      eagerToolSignature(id, registry.entries[id])
    ).join(", ")}`);
  }
  if (localToolIds.size > eagerLocalToolIds.length) {
    groups.push("other application tools are available through tools.search");
  }
  if (groups.length === 0) {
    return "Search the private catalog for available tools. Load a selected tool schema with tools.describe before you call it.";
  }
  return [
    `Core tool names and purposes are already known: ${groups.join("; ")}.`,
    "Use a known catalog ID directly. Load its schema with tools.describe only when the input is not known.",
    "Pass the exact catalog id or a selected item's id value to tools.call. Never pass a variable name as a quoted id.",
    "Use tools.search for an unknown application, MCP, OpenAPI, skill, or uncommon capability.",
    "Every execute program must return the value needed for the next model step. Never finish with only console.log or an unreturned expression.",
    "For independent reads, make one tools.batch({ calls: [{ id: item.id, input: {...} }] }) call and return its result. The batch runs them concurrently with stable replay order. Do not call tools.call sequentially for independent reads.",
    "Never use Promise.all with tools.call, and never batch writes or approval-required calls.",
  ].join(" ");
}

function eagerToolSignature(
  id: string,
  source: FlaryToolRegistry["entries"][string] | undefined,
): string {
  if (typeof source !== "function" || !source.definition.input) return `${id}({})`;
  try {
    const schema = z.toJSONSchema(source.definition.input as never) as {
      properties?: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    const properties = Object.entries(schema.properties ?? {});
    if (properties.length === 0) return `${id}({})`;
    const required = new Set(schema.required ?? []);
    const fields = properties.slice(0, 12).map(([name, property]) => {
      const optional = required.has(name) ? "" : "?";
      const values = Array.isArray(property.enum) && property.enum.length <= 8
        ? `: ${property.enum.map((value) => JSON.stringify(value)).join(" | ")}`
        : property.type === "string" || property.type === "number" || property.type === "boolean"
          ? `: ${property.type}`
          : "";
      return `${name}${optional}${values}`;
    });
    if (properties.length > fields.length) fields.push("...");
    return `${id}({ ${fields.join("; ")} })`;
  } catch {
    return `${id}({...})`;
  }
}

/** Description for the one provider-visible tool. */
export function executeToolDescription(
  registry: FlaryToolRegistry | undefined,
  eagerTools: readonly string[] = [],
): string {
  return [
    "Run bounded TypeScript in Flary's isolated tool runtime.",
    "Use tools.call({ id: item.id, input: {...} }) for one operation. Use tools.batch({ calls: [{ id: item.id, input: {...} }] }) for bounded parallel reads.",
    coreToolGuidance(registry, eagerTools),
  ]
    .filter(Boolean)
    .join(" ");
}
