import { z } from "zod";

import {
  IdentifierSchema,
  JsonObjectSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  ReferenceSchema,
  TimestampSchema,
} from "./common";
import { SecretReferenceSchema } from "./secrets";

// Identify a run input or output channel.
export const ChannelTypeSchema = z.enum([
  "webhook",
  "http",
  "slack",
  "discord",
  "email",
  "sms",
  "cli",
  "internal",
]);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

// Reference a channel by ID.
export const ChannelReferenceSchema = ReferenceSchema;
export type ChannelReference = z.infer<typeof ChannelReferenceSchema>;

// Define one delivery channel without storing credentials.
export const ChannelSchema = z
  .object({
    id: IdentifierSchema,
    type: ChannelTypeSchema,
    name: NonEmptyStringSchema,
    endpoint: z.string().url().optional(),
    destination: NonEmptyStringSchema.optional(),
    secretRefs: z.array(SecretReferenceSchema).max(32).optional(),
    config: JsonObjectSchema.optional(),
    enabled: z.boolean().optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type Channel = z.infer<typeof ChannelSchema>;

// Describe one message sent through a channel.
export const ChannelMessageSchema = z
  .object({
    id: IdentifierSchema,
    channelId: IdentifierSchema,
    subject: NonEmptyStringSchema.optional(),
    content: NonEmptyStringSchema,
    data: JsonObjectSchema.optional(),
    sentAt: TimestampSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type ChannelMessage = z.infer<typeof ChannelMessageSchema>;
