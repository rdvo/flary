import {
  ThreadBindingSchema,
  type ThreadBinding,
  ThreadDeletionSchema,
  type ThreadDeletion,
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
      CREATE TABLE IF NOT EXISTS flary_thread_deletions (
        deletion_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        completed_at TEXT,
        error_code TEXT
      )
    `).run();
    await this.#database.prepare(`
      CREATE INDEX IF NOT EXISTS flary_thread_deletions_owner
      ON flary_thread_deletions (tenant_id, application_id, accepted_at DESC)
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

  async putDeletion(input: ThreadDeletion & {
    readonly tenantId: string;
    readonly applicationId: string;
  }): Promise<ThreadDeletion> {
    // The tenant and application fields are storage routing data, not part of
    // the public deletion contract. Parse only the strict public shape so a
    // D1 write cannot reject an otherwise valid deletion acknowledgement.
    const deletion = ThreadDeletionSchema.parse({
      id: input.id,
      threadId: input.threadId,
      status: input.status,
      acceptedAt: input.acceptedAt,
      ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    });
    await this.initialize();
    await this.#database.prepare(
      `INSERT INTO flary_thread_deletions
        (deletion_id, tenant_id, application_id, thread_id, status,
         accepted_at, completed_at, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(deletion_id) DO UPDATE SET
         status = excluded.status,
         completed_at = excluded.completed_at,
         error_code = excluded.error_code`,
    ).bind(
      deletion.id,
      input.tenantId,
      input.applicationId,
      deletion.threadId,
      deletion.status,
      deletion.acceptedAt,
      deletion.completedAt ?? null,
      deletion.errorCode ?? null,
    ).run();
    return deletion;
  }

  async getDeletion(input: {
    readonly tenantId: string;
    readonly applicationId: string;
    readonly deletionId: string;
  }): Promise<ThreadDeletion | undefined> {
    await this.initialize();
    const row = await this.#database.prepare(
      `SELECT deletion_id, thread_id, status, accepted_at, completed_at, error_code
       FROM flary_thread_deletions
       WHERE tenant_id = ? AND application_id = ? AND deletion_id = ?`,
    ).bind(input.tenantId, input.applicationId, input.deletionId)
      .first<{
        deletion_id: string;
        thread_id: string;
        status: string;
        accepted_at: string;
        completed_at: string | null;
        error_code: string | null;
      }>();
    if (!row) return undefined;
    return ThreadDeletionSchema.parse({
      id: row.deletion_id,
      threadId: row.thread_id,
      status: row.status,
      acceptedAt: row.accepted_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
    });
  }
}
