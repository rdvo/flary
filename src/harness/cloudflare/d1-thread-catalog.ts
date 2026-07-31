import {
  ThreadBindingSchema,
  type ThreadBinding,
} from "../contracts/index.js";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1Statement;
  exec(query: string): Promise<unknown>;
}

/** Tenant-scoped list index. Thread Control and Flue keep authoritative state. */
export class D1ThreadCatalog {
  readonly #database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    this.#database = database;
  }

  async initialize(): Promise<void> {
    await this.#database.prepare(`
      CREATE TABLE IF NOT EXISTS flary_thread_catalog (
        tenant_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        binding_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, application_id, thread_id)
      );
    `).run();
    await this.#database.prepare(`
      CREATE INDEX IF NOT EXISTS flary_thread_catalog_list
      ON flary_thread_catalog
        (tenant_id, application_id, agent_id, status, updated_at DESC);
    `).run();
  }

  async put(bindingInput: ThreadBinding): Promise<ThreadBinding> {
    const binding = ThreadBindingSchema.parse(bindingInput);
    await this.initialize();
    await this.#database.prepare(
      `INSERT INTO flary_thread_catalog (
         tenant_id, application_id, thread_id, agent_id, status,
         updated_at, binding_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, application_id, thread_id) DO UPDATE SET
         agent_id = excluded.agent_id,
         status = excluded.status,
         updated_at = excluded.updated_at,
         binding_json = excluded.binding_json`,
    ).bind(
      binding.thread.organizationId,
      binding.thread.appId,
      binding.thread.threadId,
      binding.agentId,
      binding.status,
      binding.updatedAt,
      JSON.stringify(binding),
    ).run();
    return binding;
  }

  async list(input: {
    readonly tenantId: string;
    readonly applicationId: string;
    readonly agentId?: string;
  }): Promise<ThreadBinding[]> {
    await this.initialize();
    const result = await this.#database.prepare(
      `SELECT binding_json
       FROM flary_thread_catalog
       WHERE tenant_id = ? AND application_id = ?
         ${input.agentId ? "AND agent_id = ?" : ""}
       ORDER BY updated_at DESC, thread_id ASC`,
    ).bind(
      input.tenantId,
      input.applicationId,
      ...(input.agentId ? [input.agentId] : []),
    ).all<{ binding_json: string }>();
    return (result.results ?? []).map((row) =>
      ThreadBindingSchema.parse(JSON.parse(row.binding_json)));
  }

  async delete(input: {
    readonly tenantId: string;
    readonly applicationId: string;
    readonly threadId: string;
  }): Promise<void> {
    await this.initialize();
    await this.#database.prepare(
      `DELETE FROM flary_thread_catalog
       WHERE tenant_id = ? AND application_id = ? AND thread_id = ?`,
    ).bind(input.tenantId, input.applicationId, input.threadId).run();
  }
}
