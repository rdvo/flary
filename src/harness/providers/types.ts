import type { ProviderKind } from "../contracts/provider.js";
import type { ModelRequest, ModelResponse, ModelStreamEvent } from "./contracts.js";

export interface ProviderRequestOptions {
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
  readonly timeoutMs?: number;
}

export interface ModelAdapter {
  readonly id: string;
  readonly provider: ProviderKind;
  readonly supportsStreaming: boolean;

  complete(request: ModelRequest, options?: ProviderRequestOptions): Promise<ModelResponse>;

  stream(request: ModelRequest, options?: ProviderRequestOptions): AsyncIterable<ModelStreamEvent>;
}

export interface ProviderAdapterRegistryOptions {
  readonly adapters?: readonly ModelAdapter[];
}
