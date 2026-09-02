import { z, type ZodType } from "zod";

import {
  ModelInputSchema,
  normalizeModelInput,
  type ModelInput,
  type ModelSelection,
} from "../contracts/provider.js";
import type { JsonObject } from "../contracts/common.js";
import {
  NormalizedModelRequestSchema,
  type ModelRequest,
  type ModelResponse,
  type ProviderMessage,
} from "./contracts.js";

/** Operations that a provider may expose in addition to chat completion. */
export const ModelOperationKindSchema = z.enum([
  "text",
  "object",
  "embedding",
  "image",
  "transcription",
  "audio",
  "video",
  "rerank",
  "moderation",
]);
export type ModelOperationKind = z.infer<typeof ModelOperationKindSchema>;

const OperationMetadataSchema = z.record(z.string().max(128), z.unknown()).optional();

export const GenerateTextRequestSchema = z
  .object({
    model: ModelInputSchema.optional(),
    prompt: z.string().max(1_000_000).optional(),
    messages: z.array(z.unknown()).max(10_000).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    reasoningEffort: z.string().max(32).optional(),
    metadata: OperationMetadataSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.prompt && (!value.messages || value.messages.length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: "Provide prompt or messages",
      });
    }
    if (value.prompt && value.messages) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["messages"],
        message: "Provide prompt or messages, not both",
      });
    }
  });
export type GenerateTextRequest = z.input<typeof GenerateTextRequestSchema>;

export const GenerateObjectRequestSchema = GenerateTextRequestSchema.extend({
  schema: z.custom<ZodType>((value) => value instanceof z.ZodType, {
    message: "schema must be a Zod schema",
  }),
}).strict();
export type GenerateObjectRequest<TSchema extends ZodType = ZodType> = Omit<
  GenerateTextRequest,
  "schema"
> & { readonly schema: TSchema };

export const EmbedRequestSchema = z
  .object({
    model: ModelInputSchema.optional(),
    input: z.union([
      z.string().min(1).max(1_000_000),
      z.array(z.string().min(1).max(1_000_000)).min(1).max(10_000),
    ]),
    dimensions: z.number().int().positive().optional(),
    metadata: OperationMetadataSchema,
  })
  .strict();
export type EmbedRequest = z.input<typeof EmbedRequestSchema>;

export const GenerateImageRequestSchema = z
  .object({
    model: ModelInputSchema.optional(),
    prompt: z.string().min(1).max(1_000_000),
    size: z.string().max(32).optional(),
    quality: z.string().max(32).optional(),
    format: z.enum(["url", "base64"]).default("url"),
    count: z.number().int().positive().max(16).default(1),
    metadata: OperationMetadataSchema,
  })
  .strict();
export type GenerateImageRequest = z.input<typeof GenerateImageRequestSchema>;

export const TranscribeRequestSchema = z
  .object({
    model: ModelInputSchema.optional(),
    input: z.union([z.string().min(1), z.instanceof(Uint8Array)]),
    mimeType: z.string().max(128).optional(),
    language: z.string().max(32).optional(),
    metadata: OperationMetadataSchema,
  })
  .strict();
export type TranscribeRequest = z.input<typeof TranscribeRequestSchema>;

export const GenerateAudioRequestSchema = z
  .object({
    model: ModelInputSchema.optional(),
    input: z.string().min(1).max(1_000_000),
    voice: z.string().max(128).optional(),
    format: z.string().max(32).optional(),
    metadata: OperationMetadataSchema,
  })
  .strict();
export type GenerateAudioRequest = z.input<typeof GenerateAudioRequestSchema>;

export const GenerateVideoRequestSchema = z
  .object({
    model: ModelInputSchema.optional(),
    prompt: z.string().min(1).max(1_000_000),
    durationSeconds: z.number().finite().positive().max(3_600).optional(),
    aspectRatio: z.string().max(32).optional(),
    metadata: OperationMetadataSchema,
  })
  .strict();
export type GenerateVideoRequest = z.input<typeof GenerateVideoRequestSchema>;

export const RerankRequestSchema = z
  .object({
    model: ModelInputSchema.optional(),
    query: z.string().min(1).max(1_000_000),
    documents: z.array(z.string().min(1).max(1_000_000)).min(1).max(10_000),
    topN: z.number().int().positive().max(10_000).optional(),
    metadata: OperationMetadataSchema,
  })
  .strict();
export type RerankRequest = z.input<typeof RerankRequestSchema>;

export const ModerateRequestSchema = z
  .object({
    model: ModelInputSchema.optional(),
    input: z.union([
      z.string().min(1).max(1_000_000),
      z.array(z.string().min(1).max(1_000_000)).min(1).max(10_000),
    ]),
    metadata: OperationMetadataSchema,
  })
  .strict();
export type ModerateRequest = z.input<typeof ModerateRequestSchema>;

export const GenerateTextResultSchema = z
  .object({
    text: z.string(),
    responseId: z.string().optional(),
    model: z.string().optional(),
    usage: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type GenerateTextResult = z.infer<typeof GenerateTextResultSchema>;

export const EmbedResultSchema = z
  .object({
    embeddings: z.array(z.array(z.number().finite()).min(1)).min(1),
    model: z.string().optional(),
    usage: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type EmbedResult = z.infer<typeof EmbedResultSchema>;

export const ImageResultSchema = z
  .object({
    images: z
      .array(
        z
          .object({
            url: z.string().url().optional(),
            base64: z.string().min(1).optional(),
            mimeType: z.string().max(128).optional(),
          })
          .strict(),
      )
      .min(1),
    model: z.string().optional(),
  })
  .strict();
export type ImageResult = z.infer<typeof ImageResultSchema>;

export const TranscriptionResultSchema = z
  .object({
    text: z.string(),
    segments: z
      .array(
        z
          .object({
            text: z.string(),
            start: z.number().finite().nonnegative().optional(),
            end: z.number().finite().nonnegative().optional(),
          })
          .strict(),
      )
      .optional(),
    model: z.string().optional(),
  })
  .strict();
export type TranscriptionResult = z.infer<typeof TranscriptionResultSchema>;

export const AudioResultSchema = z
  .object({
    audio: z.string().min(1),
    mimeType: z.string().max(128),
    model: z.string().optional(),
  })
  .strict();
export type AudioResult = z.infer<typeof AudioResultSchema>;

export const VideoResultSchema = z
  .object({
    video: z.string().min(1),
    mimeType: z.string().max(128).optional(),
    model: z.string().optional(),
  })
  .strict();
export type VideoResult = z.infer<typeof VideoResultSchema>;

export const RerankResultSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            score: z.number().finite(),
            document: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
    model: z.string().optional(),
  })
  .strict();
export type RerankResult = z.infer<typeof RerankResultSchema>;

export const ModerationResultSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            flagged: z.boolean(),
            categories: z.record(z.string(), z.boolean()).default({}),
            scores: z.record(z.string(), z.number().finite()).default({}),
          })
          .strict(),
      )
      .min(1),
    model: z.string().optional(),
  })
  .strict();
export type ModerationResult = z.infer<typeof ModerationResultSchema>;

export interface ModelOperationContext<TBindings = unknown> {
  readonly bindings: TBindings;
  readonly identity?: { readonly tenantId: string; readonly userId?: string };
  readonly signal?: AbortSignal;
  readonly operationId: string;
}

export interface ModelOperationHandlers<TBindings = unknown> {
  generateText?: (
    request: GenerateTextRequest,
    context: ModelOperationContext<TBindings>,
  ) => Promise<GenerateTextResult>;
  generateObject?: (
    request: GenerateObjectRequest,
    context: ModelOperationContext<TBindings>,
  ) => Promise<unknown>;
  embed?: (
    request: EmbedRequest,
    context: ModelOperationContext<TBindings>,
  ) => Promise<EmbedResult>;
  generateImage?: (
    request: GenerateImageRequest,
    context: ModelOperationContext<TBindings>,
  ) => Promise<ImageResult>;
  transcribe?: (
    request: TranscribeRequest,
    context: ModelOperationContext<TBindings>,
  ) => Promise<TranscriptionResult>;
  generateAudio?: (
    request: GenerateAudioRequest,
    context: ModelOperationContext<TBindings>,
  ) => Promise<AudioResult>;
  generateVideo?: (
    request: GenerateVideoRequest,
    context: ModelOperationContext<TBindings>,
  ) => Promise<VideoResult>;
  rerank?: (
    request: RerankRequest,
    context: ModelOperationContext<TBindings>,
  ) => Promise<RerankResult>;
  moderate?: (
    request: ModerateRequest,
    context: ModelOperationContext<TBindings>,
  ) => Promise<ModerationResult>;
}

export class ModelOperationError extends Error {
  readonly code: string;
  readonly operation: ModelOperationKind;

  constructor(operation: ModelOperationKind, code: string, message: string) {
    super(message);
    this.name = "ModelOperationError";
    this.operation = operation;
    this.code = code;
  }
}

export interface ModelOperations<TBindings = unknown> {
  generateText(
    request: GenerateTextRequest,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<GenerateTextResult>;
  generateObject<TSchema extends ZodType>(
    request: GenerateObjectRequest<TSchema>,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<z.output<TSchema>>;
  embed(
    request: EmbedRequest,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<EmbedResult>;
  generateImage(
    request: GenerateImageRequest,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<ImageResult>;
  transcribe(
    request: TranscribeRequest,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<TranscriptionResult>;
  generateAudio(
    request: GenerateAudioRequest,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<AudioResult>;
  generateVideo(
    request: GenerateVideoRequest,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<VideoResult>;
  rerank(
    request: RerankRequest,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<RerankResult>;
  moderate(
    request: ModerateRequest,
    context?: Partial<ModelOperationContext<TBindings>>,
  ): Promise<ModerationResult>;
}

export interface CreateModelOperationsOptions<TBindings = unknown> {
  readonly handlers?: ModelOperationHandlers<TBindings>;
  readonly defaults?: { readonly model?: ModelInput };
  readonly bindings?: TBindings;
  readonly identity?: ModelOperationContext<TBindings>["identity"];
  readonly signal?: AbortSignal;
}

/**
 * Build a validated operation facade. Providers remain behind host handlers so
 * credentials and provider-specific transports never enter the public API.
 */
export function createModelOperations<TBindings = unknown>(
  options: CreateModelOperationsOptions<TBindings> = {},
): ModelOperations<TBindings> {
  const operation = async <T>(
    kind: ModelOperationKind,
    request: unknown,
    schema: ZodType,
    handler: ((request: any, context: ModelOperationContext<TBindings>) => Promise<T>) | undefined,
    contextInput: Partial<ModelOperationContext<TBindings>> | undefined,
  ): Promise<T> => {
    const parsed = schema.parse(request);
    if (!handler) {
      throw new ModelOperationError(
        kind,
        "operation_unavailable",
        `No host handler is configured for the '${kind}' model operation`,
      );
    }
    const context: ModelOperationContext<TBindings> = {
      bindings: options.bindings as TBindings,
      ...(options.identity ? { identity: options.identity } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...contextInput,
      operationId: contextInput?.operationId ?? `op_${crypto.randomUUID().replaceAll("-", "")}`,
    };
    try {
      return await handler(parsed, context);
    } catch (error) {
      if (error instanceof ModelOperationError) throw error;
      throw new ModelOperationError(
        kind,
        "operation_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const defaultModel = options.defaults?.model;
  const withDefault = <T extends Record<string, unknown>>(request: T): T =>
    defaultModel !== undefined && request.model === undefined
      ? { ...request, model: defaultModel }
      : request;
  return {
    generateText: (request, context) =>
      operation(
        "text",
        withDefault(request),
        GenerateTextRequestSchema,
        options.handlers?.generateText,
        context,
      ),
    generateObject: async (request, context) => {
      const parsed = GenerateObjectRequestSchema.parse(
        withDefault(request as Record<string, unknown>),
      );
      const result = await operation(
        "object",
        parsed,
        GenerateObjectRequestSchema,
        options.handlers?.generateObject,
        context,
      );
      return parsed.schema.parse(result) as z.output<typeof request.schema>;
    },
    embed: (request, context) =>
      operation(
        "embedding",
        withDefault(request),
        EmbedRequestSchema,
        options.handlers?.embed,
        context,
      ),
    generateImage: (request, context) =>
      operation(
        "image",
        withDefault(request),
        GenerateImageRequestSchema,
        options.handlers?.generateImage,
        context,
      ),
    transcribe: (request, context) =>
      operation(
        "transcription",
        withDefault(request),
        TranscribeRequestSchema,
        options.handlers?.transcribe,
        context,
      ),
    generateAudio: (request, context) =>
      operation(
        "audio",
        withDefault(request),
        GenerateAudioRequestSchema,
        options.handlers?.generateAudio,
        context,
      ),
    generateVideo: (request, context) =>
      operation(
        "video",
        withDefault(request),
        GenerateVideoRequestSchema,
        options.handlers?.generateVideo,
        context,
      ),
    rerank: (request, context) =>
      operation(
        "rerank",
        withDefault(request),
        RerankRequestSchema,
        options.handlers?.rerank,
        context,
      ),
    moderate: (request, context) =>
      operation(
        "moderation",
        withDefault(request),
        ModerateRequestSchema,
        options.handlers?.moderate,
        context,
      ),
  };
}

/** Convert a text request into the provider-neutral chat contract. */
export function toModelRequest(
  requestInput: GenerateTextRequest,
  defaultModel?: ModelInput,
): { readonly selection: ModelSelection; readonly request: ModelRequest } {
  const request = GenerateTextRequestSchema.parse({
    ...requestInput,
    ...(requestInput.model === undefined && defaultModel !== undefined
      ? { model: defaultModel }
      : {}),
  });
  const model = request.model ?? defaultModel;
  if (!model) throw new ModelOperationError("text", "model_missing", "A model is required");
  const selection = normalizeModelInput(model);
  const messages: ProviderMessage[] = request.prompt
    ? [{ role: "user", content: request.prompt }]
    : request.messages!.map((message) => {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          throw new ModelOperationError(
            "text",
            "message_invalid",
            "Every message must be an object",
          );
        }
        return message as ProviderMessage;
      });
  const normalized = NormalizedModelRequestSchema.parse({
    model: selection.model,
    messages,
    ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}),
    ...(request.metadata ? { metadata: request.metadata } : {}),
  });
  return { selection, request: normalized };
}

/** Create the default text/object handlers from Flary provider adapters. */
export function createAdapterOperationHandlers<TBindings = unknown>(options: {
  readonly resolveAdapter: (
    selection: ModelSelection,
    bindings: TBindings,
  ) => {
    complete(request: ModelRequest, options?: { signal?: AbortSignal }): Promise<ModelResponse>;
  };
  readonly defaultModel?: ModelInput;
}): Pick<ModelOperationHandlers<TBindings>, "generateText" | "generateObject"> {
  const complete = async (
    request: GenerateTextRequest,
    context: ModelOperationContext<TBindings>,
    object: boolean,
    schema?: ZodType,
  ) => {
    const { selection, request: normalized } = toModelRequest(request, options.defaultModel);
    const response = await options.resolveAdapter(selection, context.bindings).complete(
      {
        ...normalized,
        ...(object
          ? {
              responseFormat: {
                type: "json_object" as const,
                schema: schema ? (z.toJSONSchema(schema) as JsonObject) : undefined,
              },
            }
          : {}),
      },
      { signal: context.signal },
    );
    return response;
  };
  return {
    generateText: async (request, context) => {
      const response = await complete(request, context, false);
      return GenerateTextResultSchema.parse({
        text: response.content,
        responseId: response.id,
        model: response.model,
        usage: response.usage,
        metadata: response.metadata,
      });
    },
    generateObject: async (request, context) => {
      const response = await complete(request, context, true, request.schema);
      let value: unknown;
      try {
        value = JSON.parse(response.content);
      } catch (error) {
        throw new ModelOperationError(
          "object",
          "invalid_json",
          error instanceof Error ? error.message : "The provider returned invalid JSON",
        );
      }
      return request.schema.parse(value);
    },
  };
}
