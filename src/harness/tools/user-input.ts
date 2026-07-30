import {
  UserInputRequestSchema,
  UserInputResponseSchema,
  type UserInputRequest,
  type UserInputResponse,
} from "../contracts/index";

type PendingResolver = {
  resolve(response: UserInputResponse): void;
};

const pending = new Map<string, Map<string, PendingResolver>>();

/**
 * Wait for a live user response during the current tool call.
 *
 * The Durable Object must also persist the request. If the isolate restarts,
 * the host re-drives a new turn with `frameRestoredUserInputResponse`.
 */
export function waitForUserInput(
  threadKey: string,
  requestId: string,
): Promise<UserInputResponse> {
  return new Promise((resolve) => {
    const byRequest = pending.get(threadKey) ?? new Map();
    byRequest.set(requestId, { resolve });
    pending.set(threadKey, byRequest);
  });
}

export function resolveLiveUserInput(
  threadKey: string,
  responseInput: UserInputResponse,
): boolean {
  const response = UserInputResponseSchema.parse(responseInput);
  const byRequest = pending.get(threadKey);
  const resolver = byRequest?.get(response.requestId);
  if (!resolver) return false;
  byRequest!.delete(response.requestId);
  if (byRequest!.size === 0) pending.delete(threadKey);
  resolver.resolve(response);
  return true;
}

export function frameRestoredUserInputResponse(
  requestInput: UserInputRequest,
  responseInput: UserInputResponse,
): string {
  const request = UserInputRequestSchema.parse(requestInput);
  const response = UserInputResponseSchema.parse(responseInput);
  if (response.canceled) {
    return [
      `The user dismissed the pending question request ${request.id}.`,
      "Continue with what is known, ask a different question, or wait.",
    ].join(" ");
  }

  const lines = ["The user answered the earlier structured questions:"];
  for (const question of request.questions) {
    const answer = response.answers[question.header];
    if (answer) lines.push(`- ${question.question}: ${answer}`);
  }
  if (response.response) {
    lines.push("", `Additional note: ${response.response}`);
  }
  lines.push("", "Treat these answers as user requirements and continue.");
  return lines.join("\n");
}
