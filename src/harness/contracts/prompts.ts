import { z } from "zod";

import {
  IdentifierSchema,
  JsonValueSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  ReferenceSchema,
  VersionSchema,
} from "./common.js";

// Identify the role of one prompt message.
export const PromptRoleSchema = z.enum(["system", "developer", "user", "assistant", "tool"]);
export type PromptRole = z.infer<typeof PromptRoleSchema>;

// Identify the value type of one prompt variable.
export const PromptVariableTypeSchema = z.enum(["string", "number", "boolean", "object", "array"]);
export type PromptVariableType = z.infer<typeof PromptVariableTypeSchema>;

// Define one message in a prompt.
export const PromptMessageSchema = z
  .object({
    role: PromptRoleSchema,
    content: NonEmptyStringSchema,
    name: IdentifierSchema.optional(),
    toolCallId: IdentifierSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type PromptMessage = z.infer<typeof PromptMessageSchema>;

// Define one value that a prompt can receive.
export const PromptVariableSchema = z
  .object({
    name: IdentifierSchema,
    type: PromptVariableTypeSchema,
    description: NonEmptyStringSchema.optional(),
    required: z.boolean().optional(),
    defaultValue: JsonValueSchema.optional(),
  })
  .strict();
export type PromptVariable = z.infer<typeof PromptVariableSchema>;

// Reference a prompt manifest by ID.
export const PromptReferenceSchema = z.union([IdentifierSchema, ReferenceSchema]);
export type PromptReference = z.infer<typeof PromptReferenceSchema>;

// Define a reusable prompt template.
export const PromptManifestSchema = z
  .object({
    id: IdentifierSchema,
    version: VersionSchema,
    name: NonEmptyStringSchema.optional(),
    description: NonEmptyStringSchema.optional(),
    template: NonEmptyStringSchema.optional(),
    messages: z.array(PromptMessageSchema).min(1).optional(),
    variables: z.array(PromptVariableSchema).max(128).optional(),
    tags: z.array(IdentifierSchema).max(32).optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.template === undefined && value.messages === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["template"],
        message: "A prompt needs template or messages",
      });
    }
  });
export type PromptManifest = z.infer<typeof PromptManifestSchema>;
