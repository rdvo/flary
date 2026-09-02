import { z } from "zod";

// Use one schema for all contract IDs.
export const IdentifierSchema = z.string().min(1).max(200);
export type Identifier = z.infer<typeof IdentifierSchema>;

// Use a short string for a contract version.
export const VersionSchema = z.string().min(1).max(64);
export type Version = z.infer<typeof VersionSchema>;

// Store time values as ISO strings with a time zone.
export const TimestampSchema = z.string().datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

// Use a non-empty string for human-readable text.
export const NonEmptyStringSchema = z.string().trim().min(1);
export type NonEmptyString = z.infer<typeof NonEmptyStringSchema>;

// Use these number schemas for limits and counters.
export const PositiveIntegerSchema = z.number().int().positive();
export const NonNegativeIntegerSchema = z.number().int().nonnegative();

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

// Accept JSON data and reject undefined, bigint, and functions.
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

// Use a JSON object for extension data.
export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema);

// Use metadata for non-sensitive extension data.
export const MetadataSchema = JsonObjectSchema;
export type Metadata = z.infer<typeof MetadataSchema>;

// Reference a versioned contract without copying its content.
export const ReferenceSchema = z
  .object({
    id: IdentifierSchema,
    version: VersionSchema.optional(),
  })
  .strict();
export type Reference = z.infer<typeof ReferenceSchema>;

// Return a safe error shape from a run or tool.
export const ErrorInfoSchema = z
  .object({
    code: IdentifierSchema,
    message: NonEmptyStringSchema,
    retryable: z.boolean().optional(),
    details: JsonObjectSchema.optional(),
  })
  .strict();
export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;
