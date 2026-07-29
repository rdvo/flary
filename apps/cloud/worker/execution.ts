import {
  CloudflareDynamicWorkerAdapter,
  CloudflareSandboxAdapter,
} from "flary/cloudflare";
import {
  CodeExecutionRouter,
} from "flary/execution";
import type { CodeExecutionEvent } from "flary/contracts";

import type { Env } from "./env";

export function createCloudExecutionRouter(
  env: Env,
  organizationId: string,
): CodeExecutionRouter {
  const coordinator = env.ORG_COORDINATOR.get(
    env.ORG_COORDINATOR.idFromName(organizationId),
  );

  return new CodeExecutionRouter({
    adapters: [
      new CloudflareDynamicWorkerAdapter({
        loader: env.LOADER,
        globalOutbound: null,
      }),
      new CloudflareSandboxAdapter({
        binding: env.FLARY_SANDBOX,
      }),
    ],
    onEvent: (event) => writeExecutionEvent(coordinator, event),
  });
}

async function writeExecutionEvent(
  coordinator: DurableObjectStub,
  event: CodeExecutionEvent,
): Promise<void> {
  const response = await coordinator.fetch("https://org-coordinator/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: event.id,
      type: event.type,
      payload: event,
    }),
  });
  if (!response.ok) {
    throw new Error(`Could not store execution event (${response.status})`);
  }
}
