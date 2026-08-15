import { env } from "cloudflare:workers";
import { registerProvider } from "@flue/runtime";
import { flary, z } from "flary";

export const BindingsSchema = z.object({
  FLARY_DOCS_AGENT_TOKEN: z.string().min(32),
  FLARY_AI_GATEWAY_TOKEN: z.string().min(32),
  FLARY_INTERNAL_TOKEN: z.string().min(32),
  FLARY_SESSION_ARCHIVE_KEY: z.string().min(32),
  LOADER: z.unknown().optional(),
  FLARY_RUN_SERVICE: z.unknown().optional(),
});

const bindings = env as unknown as z.infer<typeof BindingsSchema>;

registerProvider("flary-docs-gateway", {
  api: "openai-completions",
  baseUrl:
    "https://gateway.ai.cloudflare.com/v1/26fadb0e7fb3b317bc68bd136f7e9329/flary-default/compat",
  apiKey: bindings.FLARY_AI_GATEWAY_TOKEN,
  headers: {
    "cf-aig-authorization": `Bearer ${bindings.FLARY_AI_GATEWAY_TOKEN}`,
  },
  compat: {
    maxTokensField: "max_completion_tokens",
  },
  models: {
    "openai/gpt-5.5": {
      contextWindow: 1_000_000,
      maxTokens: 32_768,
    },
  },
});

function sameString(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export const app = flary({
  name: "flary-docs-agent",
  model: "flary-docs-gateway/openai/gpt-5.5",
  bindings: BindingsSchema,
  auth: async ({ request, bindings }) => {
    if (!request) return undefined;
    const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    const sessionId = request.headers.get("x-flary-docs-session") ?? "";
    const browserId = request.headers.get("x-flary-docs-browser") ?? "";
    const tenantId = request.headers.get("x-flary-docs-tenant") ?? "";
    if (
      !bearer ||
      !sameString(bearer, bindings.FLARY_DOCS_AGENT_TOKEN) ||
      !/^[a-f0-9]{36}$/.test(sessionId) ||
      !/^[a-f0-9]{36}$/.test(browserId) ||
      (tenantId !== "flary-docs" && tenantId !== `flary-docs-${browserId}`)
    ) {
      return undefined;
    }
    return {
      tenantId,
      userId: browserId,
      roles: ["reader"],
    };
  },
});
