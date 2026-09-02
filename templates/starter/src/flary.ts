import { createMcpConnection, flary, z } from "flary";
import { generated } from "./flary.generated";

export const BindingsSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GITHUB_MCP_PAT: z.string().optional(),
  AI: z
    .custom<{ run(model: string, input: Record<string, unknown>): Promise<unknown> }>()
    .optional(),
  FLARY_ACCESS_TOKEN: z.string().optional(),
  FLARY_SESSION_ARCHIVE_KEY: z.string().optional(),
  // Cloudflare injects this Worker Loader binding in deployed environments.
  // It stays optional so local tests can run without a loader.
  LOADER: z.unknown().optional(),
  FLARY_RUN_SERVICE: z.unknown().optional(),
  FLARY_INTERNAL_TOKEN: z.string().optional(),
});

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const app = flary({
  model: generated.model,
  bindings: BindingsSchema,
  auth: async ({ request, bindings }) => {
    if (!request) return undefined;
    const local = LOCAL_HOSTS.has(new URL(request.url).hostname);
    const visitor = request.headers.get("x-flary-widget-session");
    const publicWidget =
      generated.widget &&
      new URL(request.url).pathname.startsWith("/apps/assistant/") &&
      Boolean(
        visitor &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(visitor),
      );
    const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    const personal =
      generated.authMode === "personal" &&
      Boolean(bindings.FLARY_ACCESS_TOKEN) &&
      bearer === bindings.FLARY_ACCESS_TOKEN;
    // Existing-application mode accepts local requests only. Production stays
    // closed until the application replaces this resolver with trusted identity.
    if (!local && !personal && !publicWidget) return undefined;
    return {
      tenantId: personal ? "personal" : publicWidget ? "public-widget" : "local-development",
      userId: personal ? "owner" : publicWidget ? visitor! : "local-developer",
      roles: personal || local ? ["owner"] : ["widget"],
    };
  },
  resolveMcp: (source, { bindings }) => {
    if (source.connection !== "github" || !bindings.GITHUB_MCP_PAT) {
      throw new Error("The GitHub MCP connection is not configured");
    }
    return createMcpConnection(source, {
      credentials: {
        get: async () => ({ kind: "bearer", value: bindings.GITHUB_MCP_PAT! }),
      },
    });
  },
});
