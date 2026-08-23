import { flary, z } from "flary";
import { CloudflareMcpOAuthConnections } from "flary/cloudflare";
import { createAuth } from "./auth";
import { generated } from "./flary.generated";

export const BindingsSchema = z.object({
  OPENAI_API_KEY: z.string().optional(), ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  AI: z.custom<{ run(model: string, input: Record<string, unknown>): Promise<unknown> }>().optional(),
  FLARY_INTERNAL_TOKEN: z.string(), FLARY_SESSION_ARCHIVE_KEY: z.string(),
  FLARY_TOKEN_ENCRYPTION_KEY_B64: z.string(), FLARY_SETUP_TOKEN: z.string(), BETTER_AUTH_SECRET: z.string(),
  FLARY_DASHBOARD_DB: z.custom<D1Database>(), LOADER: z.unknown().optional(),
  FLARY_RUN_SERVICE: z.unknown().optional(), FLARY_THREAD_CONTROL: z.unknown().optional(),
});
export type Bindings = z.infer<typeof BindingsSchema>;

export const app = flary({
  name: "personal-flary",
  model: generated.model,
  bindings: BindingsSchema,
  auth: async ({ request, bindings }) => {
    if (!request) return undefined;
    const session = await createAuth(bindings, new URL(request.url).origin).api.getSession({ headers: request.headers });
    if (!session?.user) return undefined;
    return { tenantId: "personal", userId: session.user.id, roles: ["owner"] };
  },
  resolveMcp: async (source, { bindings, context }) => {
    if (source.connection !== "dashboard-mcp") {
      throw new Error("The MCP connection source is not configured");
    }
    const identity = context.identity;
    if (!identity?.tenantId || !identity.userId) {
      throw new Error("An authenticated owner is required for MCP connections");
    }
    return new CloudflareMcpOAuthConnections({
      database: bindings.FLARY_DASHBOARD_DB,
      encryptionKey: bindings.FLARY_TOKEN_ENCRYPTION_KEY_B64,
    }).connection({ tenantId: identity.tenantId, userId: identity.userId });
  },
});
