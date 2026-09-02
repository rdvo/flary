import { parseThreadName } from "../storage/scopes.js";

interface PromptTraceDurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface PromptTraceDurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): PromptTraceDurableObjectStub;
}

/**
 * Store the exact rendered agent prompt in the encrypted session archive.
 *
 * The public ledger receives only its hash and size. Callers must treat this
 * as best-effort so an observability failure does not stop model execution.
 */
export async function recordResolvedAgentPrompt(input: {
  readonly env: Record<string, unknown>;
  readonly runId: string;
  readonly instructions: string;
  readonly agentRevision?: string;
}): Promise<void> {
  const namespace = input.env.FLARY_THREAD_CONTROL as PromptTraceDurableObjectNamespace | undefined;
  if (!namespace) return;
  const ref = parseThreadName(input.runId);
  const promptBytes = new TextEncoder().encode(input.instructions).byteLength;
  if (promptBytes > 1024 * 1024) {
    throw new Error("The rendered agent prompt exceeds the 1 MiB trace limit");
  }
  const promptHash = await sha256Text(input.instructions);
  const name = `thread:${ref.organizationId}:${ref.appId}:${ref.threadId}`;
  const response = await namespace.get(namespace.idFromName(name)).fetch(
    new Request("https://flary.internal/prompt-snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "recordPromptSnapshot",
        tenantId: ref.organizationId,
        applicationId: ref.appId,
        agentId: ref.agentId,
        promptHash,
        promptBytes,
        instructions: input.instructions,
        ...(input.agentRevision ? { agentRevision: input.agentRevision } : {}),
      }),
    }),
  );
  if (!response.ok) {
    const value = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
    throw new Error(
      typeof value?.error === "string" ? value.error : `Prompt trace failed (${response.status})`,
    );
  }
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
