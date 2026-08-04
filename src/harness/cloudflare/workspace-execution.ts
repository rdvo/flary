import type { DirectoryBackup, Sandbox } from "@cloudflare/sandbox";

import type { FlaryToolConnection } from "../functions/types.js";

type WorkspaceSandbox = Pick<
  Sandbox<any>,
  "createBackup" | "restoreBackup" | "listFiles" | "readFile" | "writeFile" | "mkdir" | "watch"
>;

interface WorkspaceExecutionSql {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): T[] };
}

interface WorkspaceExecutionRow {
  operation_id: string;
  state: "completed" | "outcome_unknown";
  backup_json: string | null;
  checkpoint_json: string | null;
}

export interface WorkspaceExecutionResult {
  readonly operationId: string;
  readonly state: "completed" | "outcome_unknown";
  readonly checkpoint?: unknown;
  readonly backup?: DirectoryBackup;
}

/** Common contract for stable Sandbox and experimental Computer backends. */
export interface WorkspaceExecutionBackend {
  prepare(): Promise<void>;
  settle(input: {
    readonly operationId: string;
    readonly submissionId?: string;
    readonly changed: boolean;
  }): Promise<WorkspaceExecutionResult>;
  uncertain(operationId: string): Promise<WorkspaceExecutionResult>;
}

/**
 * Keep `/workspace` durable across Cloudflare Sandbox replacement.
 *
 * The final scan is authoritative. The file watcher starts before execution
 * so the Sandbox can retain its change version, but correctness does not
 * depend on delivery of every watch event.
 */
export class CloudflareSandboxWorkspaceBackend implements WorkspaceExecutionBackend {
  readonly #sandbox: WorkspaceSandbox;
  readonly #workspace: FlaryToolConnection;
  readonly #sql: WorkspaceExecutionSql;
  readonly #sessionId: string;
  #prepared = false;

  constructor(input: {
    readonly sandbox: WorkspaceSandbox;
    readonly workspace: FlaryToolConnection;
    readonly sql: unknown;
    readonly sessionId: string;
  }) {
    this.#sandbox = input.sandbox;
    this.#workspace = input.workspace;
    this.#sql = input.sql as WorkspaceExecutionSql;
    this.#sessionId = input.sessionId;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS flary_workspace_execution (
        operation_id TEXT PRIMARY KEY NOT NULL,
        state TEXT NOT NULL,
        backup_json TEXT,
        checkpoint_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flary_workspace_execution_state (
        key TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  async prepare(): Promise<void> {
    if (this.#prepared) return;
    const latest = this.#sql.exec<{ value_json: string }>(
      "SELECT value_json FROM flary_workspace_execution_state WHERE key = 'latest-backup'",
    ).toArray()[0];
    if (latest) {
      await this.#sandbox.restoreBackup(JSON.parse(latest.value_json) as DirectoryBackup);
    } else {
      await this.#hydrateSandbox();
    }
    // Establish the watcher before a state-changing command. The final scan
    // remains the recovery source if the stream is interrupted.
    await this.#sandbox.watch("/workspace", {
      recursive: true,
      exclude: ["node_modules", ".cache", ".DS_Store"],
    });
    this.#prepared = true;
  }

  async settle(input: {
    readonly operationId: string;
    readonly submissionId?: string;
    readonly changed: boolean;
  }): Promise<WorkspaceExecutionResult> {
    const stored = this.#storedOperation(input.operationId);
    if (stored) return stored;
    if (!input.changed) {
      const result = { operationId: input.operationId, state: "completed" as const };
      this.#storeOperation(result);
      return result;
    }
    await this.#syncWorkspace();
    const checkpoint = await this.#workspace.call("__checkpoint", {
      id: `sandbox_${input.operationId}`.slice(0, 200),
      sessionId: this.#sessionId,
      ...(input.submissionId ? { submissionId: input.submissionId } : {}),
    });
    const backup = await this.#sandbox.createBackup({
      dir: "/workspace",
      name: `flary-${this.#sessionId}-${input.operationId}`.slice(0, 200),
      ttl: 30 * 24 * 60 * 60,
      gitignore: false,
      excludes: ["node_modules", ".cache", ".npm", ".pnpm-store"],
      localBucket: true,
      compression: { format: "zstd" },
    });
    this.#sql.exec(
      `INSERT INTO flary_workspace_execution_state (key, value_json, updated_at)
       VALUES ('latest-backup', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      JSON.stringify(backup),
      new Date().toISOString(),
    );
    const result = {
      operationId: input.operationId,
      state: "completed" as const,
      checkpoint,
      backup,
    };
    this.#storeOperation(result);
    return result;
  }

  async uncertain(operationId: string): Promise<WorkspaceExecutionResult> {
    const stored = this.#storedOperation(operationId);
    if (stored) return stored;
    const result = { operationId, state: "outcome_unknown" as const };
    this.#storeOperation(result);
    return result;
  }

  async #hydrateSandbox(): Promise<void> {
    const listing = await this.#workspace.call("list", {});
    const files = Array.isArray(record(listing).files) ? record(listing).files as unknown[] : [];
    for (const item of files) {
      const file = record(item);
      if (typeof file.path !== "string" || excluded(file.path)) continue;
      const opened = record(await this.#workspace.call("read", {
        path: file.path,
        encoding: binaryMediaType(String(file.mediaType ?? "")) ? "base64" : "utf8",
      }));
      const absolute = `/workspace/${file.path.replace(/^\/+/, "")}`;
      await this.#sandbox.mkdir(absolute.split("/").slice(0, -1).join("/") || "/workspace", {
        recursive: true,
      });
      await this.#sandbox.writeFile(absolute, String(opened.content ?? ""), {
        encoding: opened.encoding === "base64" ? "base64" : "utf8",
      });
    }
  }

  async #syncWorkspace(): Promise<void> {
    const scan = await this.#sandbox.listFiles("/workspace", {
      recursive: true,
      includeHidden: true,
    });
    const sandboxFiles = scan.files.filter((file) =>
      file.type === "file" && !excluded(file.relativePath),
    );
    const existing = record(await this.#workspace.call("list", {}));
    const current = new Set(
      (Array.isArray(existing.files) ? existing.files : [])
        .map((file) => record(file).path)
        .filter((path): path is string => typeof path === "string"),
    );
    const kept = new Set<string>();
    for (const file of sandboxFiles) {
      const path = file.relativePath.replace(/^\/+/, "");
      kept.add(path);
      const opened = await this.#sandbox.readFile(file.absolutePath, { encoding: "base64" });
      await this.#workspace.call("write", {
        path,
        content: opened.content,
        encoding: "base64",
        ...(opened.mimeType ? { mediaType: opened.mimeType } : {}),
      });
    }
    for (const path of current) {
      if (!kept.has(path) && !excluded(path)) {
        await this.#workspace.call("delete", { path });
      }
    }
  }

  #storeOperation(result: WorkspaceExecutionResult): void {
    this.#sql.exec(
      `INSERT INTO flary_workspace_execution
        (operation_id, state, backup_json, checkpoint_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(operation_id) DO UPDATE SET
         state = excluded.state,
         backup_json = excluded.backup_json,
         checkpoint_json = excluded.checkpoint_json,
         updated_at = excluded.updated_at`,
      result.operationId,
      result.state,
      result.backup ? JSON.stringify(result.backup) : null,
      result.checkpoint ? JSON.stringify(result.checkpoint) : null,
      new Date().toISOString(),
    );
  }

  #storedOperation(operationId: string): WorkspaceExecutionResult | undefined {
    const row = this.#sql.exec<WorkspaceExecutionRow>(
      `SELECT operation_id, state, backup_json, checkpoint_json
       FROM flary_workspace_execution WHERE operation_id = ?`,
      operationId,
    ).toArray()[0];
    if (!row) return undefined;
    return {
      operationId: row.operation_id,
      state: row.state,
      ...(row.backup_json
        ? { backup: JSON.parse(row.backup_json) as DirectoryBackup }
        : {}),
      ...(row.checkpoint_json
        ? { checkpoint: JSON.parse(row.checkpoint_json) }
        : {}),
    };
  }
}

/** Preview adapter for `@cloudflare/computer`; stable 0.8 does not depend on it. */
export class CloudflareComputerWorkspaceBackend implements WorkspaceExecutionBackend {
  readonly #driver: WorkspaceExecutionBackend;

  constructor(driver: WorkspaceExecutionBackend) {
    this.#driver = driver;
  }

  prepare(): Promise<void> {
    return this.#driver.prepare();
  }

  settle(input: {
    readonly operationId: string;
    readonly submissionId?: string;
    readonly changed: boolean;
  }): Promise<WorkspaceExecutionResult> {
    return this.#driver.settle(input);
  }

  uncertain(operationId: string): Promise<WorkspaceExecutionResult> {
    return this.#driver.uncertain(operationId);
  }
}

function excluded(path: string): boolean {
  const normalized = path.replace(/^\/+/, "");
  return normalized === "node_modules" || normalized.startsWith("node_modules/") ||
    normalized === ".cache" || normalized.startsWith(".cache/") ||
    normalized === ".npm" || normalized.startsWith(".npm/") ||
    normalized === ".pnpm-store" || normalized.startsWith(".pnpm-store/");
}

function binaryMediaType(value: string): boolean {
  return value.length > 0 && !value.startsWith("text/") &&
    !value.includes("json") && !value.includes("javascript") &&
    !value.includes("typescript") && !value.includes("yaml") &&
    !value.includes("xml");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
