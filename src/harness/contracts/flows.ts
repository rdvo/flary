import { z } from "zod";

import {
  IdentifierSchema,
  JsonObjectSchema,
  JsonValueSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  VersionSchema,
} from "./common";

const FlowNodeBaseFields = {
  id: IdentifierSchema,
  name: NonEmptyStringSchema.optional(),
  metadata: MetadataSchema.optional(),
};

// Identify the kind of one flow node.
export const FlowNodeKindSchema = z.enum([
  "agent",
  "tool",
  "transform",
  "branch",
  "parallel",
]);
export type FlowNodeKind = z.infer<typeof FlowNodeKindSchema>;

// Run an agent from a flow node.
export const FlowAgentNodeSchema = z
  .object({
    ...FlowNodeBaseFields,
    kind: z.literal("agent"),
    agentId: IdentifierSchema,
    input: JsonValueSchema.optional(),
  })
  .strict();
export type FlowAgentNode = z.infer<typeof FlowAgentNodeSchema>;

// Run a tool from a flow node.
export const FlowToolNodeSchema = z
  .object({
    ...FlowNodeBaseFields,
    kind: z.literal("tool"),
    toolId: IdentifierSchema,
    input: JsonObjectSchema.optional(),
  })
  .strict();
export type FlowToolNode = z.infer<typeof FlowToolNodeSchema>;

// Transform flow data with a named expression.
export const FlowTransformNodeSchema = z
  .object({
    ...FlowNodeBaseFields,
    kind: z.literal("transform"),
    expression: NonEmptyStringSchema,
    input: JsonValueSchema.optional(),
  })
  .strict();
export type FlowTransformNode = z.infer<typeof FlowTransformNodeSchema>;

// Select the next edge from a condition.
export const FlowBranchNodeSchema = z
  .object({
    ...FlowNodeBaseFields,
    kind: z.literal("branch"),
    expression: NonEmptyStringSchema,
  })
  .strict();
export type FlowBranchNode = z.infer<typeof FlowBranchNodeSchema>;

// Run several child nodes as one group.
export const FlowParallelNodeSchema = z
  .object({
    ...FlowNodeBaseFields,
    kind: z.literal("parallel"),
    nodeIds: z.array(IdentifierSchema).min(1).max(256),
  })
  .strict();
export type FlowParallelNode = z.infer<typeof FlowParallelNodeSchema>;

// Define one node in a flow DAG.
export const FlowNodeSchema = z.discriminatedUnion("kind", [
  FlowAgentNodeSchema,
  FlowToolNodeSchema,
  FlowTransformNodeSchema,
  FlowBranchNodeSchema,
  FlowParallelNodeSchema,
]);
export type FlowNode = z.infer<typeof FlowNodeSchema>;

// Connect two nodes in a flow DAG.
export const FlowEdgeSchema = z
  .object({
    from: IdentifierSchema,
    to: IdentifierSchema,
    condition: NonEmptyStringSchema.optional(),
  })
  .strict();
export type FlowEdge = z.infer<typeof FlowEdgeSchema>;

// Reference a flow manifest by ID.
export const FlowReferenceSchema = z
  .object({
    id: IdentifierSchema,
    version: VersionSchema.optional(),
  })
  .strict();
export type FlowReference = z.infer<typeof FlowReferenceSchema>;

function hasCycle(nodes: string[], edges: ReadonlyArray<FlowEdge>): boolean {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node, []);
  }
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (node: string): boolean => {
    if (visiting.has(node)) {
      return true;
    }
    if (visited.has(node)) {
      return false;
    }

    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (visit(next)) {
        return true;
      }
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };

  return nodes.some(visit);
}

// Define a versioned flow DAG.
export const FlowManifestSchema = z
  .object({
    id: IdentifierSchema,
    version: VersionSchema,
    name: NonEmptyStringSchema.optional(),
    description: NonEmptyStringSchema.optional(),
    entryNodeId: IdentifierSchema,
    nodes: z.array(FlowNodeSchema).min(1).max(512),
    edges: z.array(FlowEdgeSchema).max(2048),
    outputNodeIds: z.array(IdentifierSchema).max(512).optional(),
    inputSchema: JsonObjectSchema.optional(),
    outputSchema: JsonObjectSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const nodeIds = value.nodes.map((node) => node.id);
    const nodeSet = new Set<string>();

    value.nodes.forEach((node, index) => {
      if (nodeSet.has(node.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", index, "id"],
          message: "Node IDs must be unique",
        });
      }
      nodeSet.add(node.id);
    });

    if (!nodeSet.has(value.entryNodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entryNodeId"],
        message: "entryNodeId must name a node",
      });
    }

    const edgeSet = new Set<string>();
    value.edges.forEach((edge, index) => {
      if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index],
          message: "Flow edges must name existing nodes",
        });
      }
      if (edge.from === edge.to) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index],
          message: "A flow node cannot point to itself",
        });
      }
      const key = `${edge.from}\u0000${edge.to}\u0000${edge.condition ?? ""}`;
      if (edgeSet.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index],
          message: "Flow edges must be unique",
        });
      }
      edgeSet.add(key);
    });

    for (const nodeId of value.outputNodeIds ?? []) {
      if (!nodeSet.has(nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputNodeIds"],
          message: "outputNodeIds must name existing nodes",
        });
        break;
      }
    }

    if (value.edges.every((edge) => nodeSet.has(edge.from) && nodeSet.has(edge.to))) {
      if (hasCycle(nodeIds, value.edges)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges"],
          message: "Flow edges must form a DAG",
        });
      }
    }
  });
export type FlowManifest = z.infer<typeof FlowManifestSchema>;

// Keep both DAG spellings available to callers.
export const FlowDagManifestSchema = FlowManifestSchema;
export type FlowDagManifest = FlowManifest;
export const FlowDAGManifestSchema = FlowManifestSchema;
export type FlowDAGManifest = FlowManifest;
