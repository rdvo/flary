import type { ModelSelection } from "../contracts/provider.js";
import type { ModelAdapter, ProviderAdapterRegistryOptions } from "./types.js";

export class ProviderAdapterRegistry {
  private readonly adapters = new Map<string, ModelAdapter>();

  constructor(options: ProviderAdapterRegistryOptions = {}) {
    for (const adapter of options.adapters ?? []) this.register(adapter);
  }

  register(adapter: ModelAdapter): this {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`A provider adapter is already registered for '${adapter.id}'.`);
    }
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(provider: string): ModelAdapter | undefined {
    return this.adapters.get(provider);
  }

  resolve(selection: Pick<ModelSelection, "provider"> | string): ModelAdapter {
    const provider = typeof selection === "string" ? selection : selection.provider;
    const adapter = this.get(provider);
    if (!adapter) {
      throw new Error(`No provider adapter is registered for '${provider}'.`);
    }
    return adapter;
  }

  has(provider: string): boolean {
    return this.adapters.has(provider);
  }

  list(): readonly ModelAdapter[] {
    return [...this.adapters.values()];
  }
}

export { ProviderAdapterRegistry as ProviderRegistry };
