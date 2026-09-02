import { z } from "zod";

import {
  IdentifierSchema,
  JsonObjectSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  ReferenceSchema,
  VersionSchema,
} from "./common.js";
import { ExecutionProfileReferenceSchema } from "./execution.js";
import { IdentityReferenceSchema } from "./identity.js";
import { ModelSelectionSchema, TextVerbositySchema } from "./provider.js";
import { PromptReferenceSchema } from "./prompts.js";
import { ToolReferenceSchema } from "./tools.js";
import { AgentModeIdSchema, AgentModeSchema } from "./modes.js";
import {
  DelegationPolicySchema,
  SubagentContextSeedSchema,
  SubagentRoleSchema,
} from "./subagents.js";

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
