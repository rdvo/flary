import { flary, z } from "flary";

export const BindingsSchema = z.object({
  APP_ENV: z.string().default("development"),
  OPENAI_API_KEY: z.string().optional(),
  // Cloudflare injects this Worker Loader binding in deployed environments.
  // It stays optional so local tests can run without a loader.
  LOADER: z.unknown().optional(),
  FLARY_RUN_SERVICE: z.unknown().optional(),
  FLARY_INTERNAL_TOKEN: z.string().optional(),
});

export const app = flary({
  model: "openai/gpt-5",
  bindings: BindingsSchema,
  auth: async ({ bindings }) => ({
    tenantId: bindings.APP_ENV,
    roles: ["user"],
  }),
});
