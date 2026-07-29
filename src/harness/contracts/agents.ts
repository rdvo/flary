import { z } from "zod";

import {
  IdentifierSchema,
  JsonObjectSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  ReferenceSchema,
  VersionSchema,
} from "./common";
import { ExecutionProfileReferenceSchema } from "./execution";
import { IdentityReferenceSchema } from "./identity";
import { ModelSelectionSchema, TextVerbositySchema } from "./provider";
import { PromptReferenceSchema } from "./prompts";
import { ToolReferenceSchema } from "./tools";
import { AgentModeIdSchema, AgentModeSchema } from "./modes";
import {
  DelegationPolicySchema,
  SubagentContextSeedSchema,
  SubagentRoleSchema,
} from "./subagents";

// Reference an agent manifest by ID.
export const AgentReferenceSchema = ReferenceSchema;
export type AgentReference = z.infer<typeof AgentReferenceSchema>;

// Define the prompt, model, and tools for one agent.
export const AgentManifestSchema = z
  .object({
    id: IdentifierSchema,
    version: VersionSchema,
    name: NonEmptyStringSchema.optional(),
    description: NonEmptyStringSchema.optional(),
    prompt: PromptReferenceSchema,
    model: ModelSelectionSchema.optional(),
    profile: ExecutionProfileReferenceSchema.optional(),
    tools: z.array(ToolReferenceSchema).max(256).optional(),
    identity: IdentityReferenceSchema.optional(),
    role: SubagentRoleSchema.optional(),
    mode: AgentModeIdSchema.optional(),
    modes: z.array(AgentModeSchema).max(32).optional(),
    verbosity: TextVerbositySchema.optional(),
    contextSeed: SubagentContextSeedSchema.optional(),
    delegation: DelegationPolicySchema.optional(),
    subagents: z.array(AgentReferenceSchema).max(64).optional(),
    inputSchema: JsonObjectSchema.optional(),
    outputSchema: JsonObjectSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type AgentManifest = z.infer<typeof AgentManifestSchema>;
