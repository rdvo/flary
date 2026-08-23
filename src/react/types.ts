import type { FlaryAgentThreadHandle } from "../harness/client/functions.js";
import type { ThreadBinding } from "../harness/contracts/index.js";

export interface FlaryReactAgentClient {
  readonly threads: {
    list(): Promise<ThreadBinding[]>;
    create(input: { title?: string }): Promise<FlaryAgentThreadHandle>;
    open(input: {
      organizationId: string;
      threadId: string;
    }): Promise<FlaryAgentThreadHandle>;
  };
}

export interface FlaryPendingMessage {
  id: string;
  text: string;
  createdAt: string;
}

export type FlaryConnectionState =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "offline";
