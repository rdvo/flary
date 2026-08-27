import { z } from "zod";

import {
  IdentifierSchema,
  MetadataSchema,
  NonEmptyStringSchema,
  TimestampSchema,
} from "./common";
import { IdentityReferenceSchema } from "./identity";

export const UserInputOptionSchema = z
  .object({
    label: NonEmptyStringSchema.max(120),
    description: z.string().trim().max(500).default(""),
    preview: z.string().trim().max(20_000).optional(),
  })
  .strict();
export type UserInputOption = z.infer<typeof UserInputOptionSchema>;

export const UserInputQuestionSchema = z
  .object({
    header: NonEmptyStringSchema.max(80),
    question: NonEmptyStringSchema.max(4_000),
    /** Empty options make this a free-form text question. */
    options: z.array(UserInputOptionSchema).max(10).default([]),
    multiSelect: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.multiSelect && value.options.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["multiSelect"],
        message: "Free-form questions cannot use multi-select",
      });
    }
  });
export type UserInputQuestion = z.infer<typeof UserInputQuestionSchema>;

export const UserInputRequestSchema = z
  .object({
    id: IdentifierSchema,
    threadId: IdentifierSchema,
    questions: z.array(UserInputQuestionSchema).min(1).max(3),
    requestedBy: IdentityReferenceSchema,
    requestedAt: TimestampSchema,
    expiresAt: TimestampSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const headers = value.questions.map((question) => question.header);
    if (new Set(headers).size !== headers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questions"],
        message: "Question headers must be unique",
      });
    }
  });
export type UserInputRequest = z.infer<typeof UserInputRequestSchema>;

export const UserInputResponseSchema = z
  .object({
    requestId: IdentifierSchema,
    answers: z.record(z.string(), z.string().max(100_000)).default({}),
    response: z.string().max(100_000).optional(),
    canceled: z.boolean().default(false),
    answeredBy: IdentityReferenceSchema,
    answeredAt: TimestampSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type UserInputResponse = z.infer<typeof UserInputResponseSchema>;

export const UserInputRecordSchema = z
  .object({
    request: UserInputRequestSchema,
    response: UserInputResponseSchema.nullable(),
  })
  .strict();
export type UserInputRecord = z.infer<typeof UserInputRecordSchema>;

export const UserInputAnswerRequestSchema = z
  .object({
    answers: z.record(z.string(), z.string().max(100_000)).default({}),
    response: z.string().max(100_000).optional(),
    canceled: z.boolean().default(false),
    metadata: MetadataSchema.optional(),
  })
  .strict();
export type UserInputAnswerRequest = z.input<
  typeof UserInputAnswerRequestSchema
>;
