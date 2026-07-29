import { z } from "zod";

import {
  IdentifierSchema,
  JsonValueSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  TimestampSchema,
  VersionSchema,
} from "./common";
import { RunTargetSchema } from "./runs";

// Define when a schedule starts a run.
export const ScheduleTriggerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("cron"),
      expression: NonEmptyStringSchema,
      timezone: NonEmptyStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("interval"),
      intervalMs: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("once"),
      at: TimestampSchema,
    })
    .strict(),
]);
export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;

// Use the same target shape for scheduled and direct runs.
export const ScheduleTargetSchema = RunTargetSchema;
export type ScheduleTarget = z.infer<typeof ScheduleTargetSchema>;

// Define one persistent run schedule.
export const ScheduleSchema = z
  .object({
    id: IdentifierSchema,
    version: VersionSchema.optional(),
    name: NonEmptyStringSchema,
    target: ScheduleTargetSchema,
    trigger: ScheduleTriggerSchema,
    input: JsonValueSchema.optional(),
    enabled: z.boolean(),
    identityId: IdentifierSchema.optional(),
    channelId: IdentifierSchema.optional(),
    createdAt: TimestampSchema.optional(),
    updatedAt: TimestampSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type Schedule = z.infer<typeof ScheduleSchema>;

// Keep manifest wording available for schedule registries.
export const ScheduleManifestSchema = ScheduleSchema;
export type ScheduleManifest = Schedule;
