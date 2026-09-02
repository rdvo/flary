import { z } from "zod";

const RealtimeIdentifierSchema = z.string().trim().min(1).max(512);

export const RealtimeTicketRequestSchema = z
  .object({
    after: z.number().int().nonnegative().default(0),
    includeChildren: z.boolean().default(false),
  })
  .strict();
export type RealtimeTicketRequest = z.input<typeof RealtimeTicketRequestSchema>;

export const RealtimeTicketResponseSchema = z
  .object({
    url: z.string().url(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type RealtimeTicketResponse = z.infer<typeof RealtimeTicketResponseSchema>;

export const RealtimeCommandNameSchema = z.enum([
  "send",
  "steer",
  "interrupt",
  "approve",
  "reject",
  "user_input",
  "subagent",
  "process.attach",
  "process.stdin",
  "process.signal",
  "process.resize",
  "process.sleep",
  "process.wake",
  "browser.takeover",
  "browser.input",
  "browser.release",
]);
export type RealtimeCommandName = z.infer<typeof RealtimeCommandNameSchema>;

export const RealtimeClientFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      version: z.literal(1),
      type: z.literal("command"),
      requestId: RealtimeIdentifierSchema,
      idempotencyKey: RealtimeIdentifierSchema,
      command: RealtimeCommandNameSchema,
      input: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("ack"),
      cursor: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("ping"),
      requestId: RealtimeIdentifierSchema.optional(),
    })
    .strict(),
]);
export type RealtimeClientFrame = z.infer<typeof RealtimeClientFrameSchema>;

export const RealtimeServerFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      version: z.literal(1),
      type: z.literal("ready"),
      threadId: RealtimeIdentifierSchema,
      cursor: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("events"),
      cursor: z.number().int().nonnegative(),
      records: z.array(z.record(z.string(), z.unknown())).max(500),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("accepted"),
      requestId: RealtimeIdentifierSchema,
      duplicate: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("result"),
      requestId: RealtimeIdentifierSchema,
      result: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("error"),
      requestId: RealtimeIdentifierSchema.optional(),
      code: RealtimeIdentifierSchema,
      message: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("resync_required"),
      cursor: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("pong"),
      requestId: RealtimeIdentifierSchema.optional(),
    })
    .strict(),
]);
export type RealtimeServerFrame = z.infer<typeof RealtimeServerFrameSchema>;
