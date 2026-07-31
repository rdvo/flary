import { flary, z } from "flary";

export const BindingsSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  // Cloudflare injects this Worker Loader binding in deployed environments.
  // It stays optional so local tests can run without a loader.
  LOADER: z.unknown().optional(),
  FLARY_RUN_SERVICE: z.unknown().optional(),
  FLARY_INTERNAL_TOKEN: z.string().optional(),
});

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const app = flary({
  model: "openai/gpt-5",
  bindings: BindingsSchema,
  // Local development gets one placeholder identity. Every deployed request
  // is rejected until this resolver is replaced with product authentication.
  auth: async ({ request }) => {
    if (!request || !LOCAL_HOSTS.has(new URL(request.url).hostname)) {
      return undefined;
    }
    return {
      tenantId: "local-development",
      userId: "local-developer",
      roles: ["developer"],
    };
  },
});
