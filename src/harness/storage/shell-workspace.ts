import {
  Workspace,
  createWorkspaceStateBackend,
  type StateBackend,
} from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import { gitTools, type GitToolsOptions } from "@cloudflare/shell/git";
import type { ToolProvider } from "@cloudflare/codemode";
import type { SqlStorage } from "@cloudflare/workers-types";

import {
  ProjectFileCopyRequestSchema,
  ProjectFileDeleteRequestSchema,
  ProjectFileDeleteResponseSchema,
  ProjectFileEditRequestSchema,
  ProjectFileEditResponseSchema,
  ProjectFileEntrySchema,
  ProjectFileListRequestSchema,
  ProjectFileListResponseSchema,
  ProjectFileMoveRequestSchema,
  ProjectFileMutationResponseSchema,
  ProjectFilePatchRequestSchema,
  ProjectFilePatchResponseSchema,
  ProjectFileReadRequestSchema,
  ProjectFileReadResponseSchema,
  ProjectFileWriteRequestSchema,
  type ProjectFileCopyRequestInput,
  type ProjectFileDeleteRequestInput,
  type ProjectFileEditRequestInput,
  type ProjectFileListRequestInput,
  type ProjectFileMoveRequestInput,
  type ProjectFilePatchRequestInput,
  type ProjectFileMutationResponse,
  type ProjectFileReadRequest,
  type ProjectFileReadResponse,
  type ProjectFileWriteRequestInput,
} from "../contracts/filesystem.js";
import {
  WorkspaceBatchEditRequestSchema,
  WorkspaceBatchEditResponseSchema,
  WorkspaceDiffRequestSchema,
  WorkspaceDiffResponseSchema,
  WorkspaceGlobRequestSchema,
  WorkspaceGlobResponseSchema,
  WorkspaceGrepRequestSchema,
  WorkspaceGrepResponseSchema,
  type WorkspaceBatchEditRequestInput,
  type WorkspaceDiffRequestInput,
  type WorkspaceGlobRequestInput,
  type WorkspaceGrepRequestInput,
} from "../contracts/workspace-tools.js";
import type { StorageScope } from "../contracts/tenancy.js";
import { tenantBlobKey, tenantStoragePrefix } from "./scopes.js";
import {
  decodeWorkspaceFileContent,
  workspaceBytesToBase64,
  workspacePathMatches,
  workspaceSha256Hex,
} from "./workspace-codec.js";
import { applyWorkspaceUnifiedPatch } from "./workspace-patch.js";

export const FLARY_WORKSPACE_INLINE_THRESHOLD = 1_500_000;

export interface ShellWorkspaceOptions {
  sql: SqlStorage;
  /** Kept structural so host applications can use their generated Workers types. */
  r2?: unknown;
  scope: StorageScope;
  inlineThreshold?: number;
  requireR2ForLargeFiles?: boolean;
}

export interface ShellWorkspaceByteWrite {
  path: string;
  bytes: Uint8Array;
  mediaType?: string;
  expectedSha256?: string;
}

type ShellR2Bucket = NonNullable<
  ConstructorParameters<typeof Workspace>[0]["r2"]
>;

type WorkspaceFileRow = {
  path: string;
  size: number;
  sha256: string;
  media_type: string;
  storage_key: string | null;
  created_at: string;
  updated_at: string;
};

type BlobBucket = Pick<ShellR2Bucket, "put" | "get" | "delete">;

/**
 * Stable Flary adapter over Cloudflare Shell.
 *
 * Shell owns file bytes and SQLite/R2 tiering. Flary owns tenant scope,
 * response contracts, hashes, and the production R2 requirement.
 */
export class ShellWorkspace {
  readonly workspace: Workspace;
  readonly #sql: SqlStorage;
  readonly #scope: StorageScope;
  readonly #r2: BlobBucket | undefined;
  readonly #inlineThreshold: number;
  readonly #requireR2ForLargeFiles: boolean;
  readonly #hasR2: boolean;

  constructor(options: ShellWorkspaceOptions) {
    this.#sql = options.sql;
    this.#scope = options.scope;
    this.#r2 = options.r2 as BlobBucket | undefined;
    this.#inlineThreshold =
      options.inlineThreshold ?? FLARY_WORKSPACE_INLINE_THRESHOLD;
    this.#requireR2ForLargeFiles = options.requireR2ForLargeFiles ?? true;
    this.#hasR2 = Boolean(options.r2);
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS flary_workspace_file_meta (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        media_type TEXT NOT NULL,
        storage_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flary_workspace_file_meta_updated_idx
        ON flary_workspace_file_meta(updated_at);
    `);
    this.ensureStorageKeyColumn();

    this.workspace = new Workspace({
      sql: options.sql,
      namespace: "flary_shell",
      r2: options.r2 as ShellR2Bucket | undefined,
      r2Prefix: `${tenantStoragePrefix(options.scope)}/shell`,
      // Shell spills at >= threshold. Add one byte so Flary's contract keeps
      // exactly 1,500,000 bytes inline and spills only larger files.
      inlineThreshold: this.#inlineThreshold + 1,
      name: `workspace:${options.scope.workspaceId}`,
    });
  }

  async write(
    input: ProjectFileWriteRequestInput,
  ): Promise<ProjectFileMutationResponse> {
    const request = ProjectFileWriteRequestSchema.parse(input);
    const bytes = decodeWorkspaceFileContent(request.content, request.encoding);
    return this.writeBytes({
      path: request.path,
      bytes,
      mediaType: request.mediaType,
      expectedSha256: request.expectedSha256,
    });
  }

  async writeBytes(
    input: ShellWorkspaceByteWrite,
  ): Promise<ProjectFileMutationResponse> {
    if (!(input.bytes instanceof Uint8Array)) {
      throw new Error("Workspace bytes must be a Uint8Array");
    }
    const request = ProjectFileWriteRequestSchema.parse({
      path: input.path,
      content: "",
      mediaType: input.mediaType,
      expectedSha256: input.expectedSha256,
    });
    const bytes = input.bytes;
    const sha256 = await workspaceSha256Hex(bytes);
    if (request.expectedSha256 && request.expectedSha256 !== sha256) {
      throw new Error("File content does not match expectedSha256");
    }
    if (
      bytes.byteLength > this.#inlineThreshold &&
      this.#requireR2ForLargeFiles &&
      !this.#hasR2
    ) {
      throw new Error("R2 is required for files larger than 1.5 MB");
    }

    const previous = this.#getMeta(request.path);
    const storageKey =
      bytes.byteLength > this.#inlineThreshold
        ? tenantBlobKey(this.#scope, sha256)
        : null;
    if (storageKey) {
      await this.#r2!.put(storageKey, bytes, {
        httpMetadata: { contentType: request.mediaType },
        customMetadata: {
          organizationId: this.#scope.organizationId,
          appId: this.#scope.appId,
          projectId: this.#scope.projectId,
          workspaceId: this.#scope.workspaceId,
          sha256,
        },
      });
      if (previous && !previous.storage_key) {
        await this.workspace.deleteFile(shellPath(request.path));
      }
    } else {
      await this.workspace.writeFileBytes(
        shellPath(request.path),
        bytes,
        request.mediaType,
      );
    }
    if (
      previous?.storage_key &&
      previous.storage_key !== storageKey &&
      this.#r2
    ) {
      await this.#r2.delete(previous.storage_key);
    }
    const now = new Date().toISOString();
    this.#sql.exec(
      `INSERT INTO flary_workspace_file_meta
        (path, size, sha256, media_type, storage_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
        size = excluded.size,
        sha256 = excluded.sha256,
        media_type = excluded.media_type,
        storage_key = excluded.storage_key,
        updated_at = excluded.updated_at`,
      request.path,
      bytes.byteLength,
      sha256,
      request.mediaType,
      storageKey,
      previous?.created_at ?? now,
      now,
    );
    return ProjectFileMutationResponseSchema.parse({
      file: this.#entry({
        path: request.path,
        size: bytes.byteLength,
        sha256,
        media_type: request.mediaType,
        storage_key: storageKey,
        created_at: previous?.created_at ?? now,
        updated_at: now,
      }),
    });
  }

  async read(input: ProjectFileReadRequest): Promise<ProjectFileReadResponse> {
    const request = ProjectFileReadRequestSchema.parse(input);
    const meta = this.#requireMeta(request.path);
    const bytes = await this.readBytes(meta);
    if (!bytes) throw new Error(`Stored bytes are missing for ${request.path}`);
    const digest = await workspaceSha256Hex(bytes);
    if (digest !== meta.sha256) {
      throw new Error(`Stored bytes failed integrity check for ${request.path}`);
    }
    const encoding =
      request.encoding ?? (isTextMediaType(meta.media_type) ? "utf8" : "base64");
    return ProjectFileReadResponseSchema.parse({
      file: this.#entry(meta),
      content:
        encoding === "utf8"
          ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
          : workspaceBytesToBase64(bytes),
      encoding,
    });
  }

  async stat(path: string) {
    return this.#entry(this.#requireMeta(path));
  }

  async list(input: ProjectFileListRequestInput = {}) {
    const request = ProjectFileListRequestSchema.parse(input);
    const files = this.#listMeta()
      .map((row) => this.#entry(row))
      .filter((entry) =>
        workspacePathMatches(entry.path, request.prefix, request.recursive),
      )
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, request.limit);
    return ProjectFileListResponseSchema.parse({ files });
  }

  async delete(input: ProjectFileDeleteRequestInput) {
    const request = ProjectFileDeleteRequestSchema.parse(input);
    const rows = this.#listMeta().filter((row) => {
      if (!request.recursive) return row.path === request.path;
      return (
        request.path === "" ||
        row.path === request.path ||
        row.path.startsWith(`${request.path}/`)
      );
    });
    if (rows.length > 0) {
      for (const row of rows) {
        if (row.storage_key && this.#r2) {
          await this.#r2.delete(row.storage_key);
        }
      }
      if (rows.some((row) => !row.storage_key)) {
        await this.workspace.rm(shellPath(request.path), {
          recursive: request.recursive,
          force: true,
        });
      }
      if (request.recursive) {
        this.#sql.exec(
          "DELETE FROM flary_workspace_file_meta WHERE path = ? OR path LIKE ?",
          request.path,
          `${request.path}/%`,
        );
      } else {
        this.#sql.exec(
          "DELETE FROM flary_workspace_file_meta WHERE path = ?",
          request.path,
        );
      }
    }
    return ProjectFileDeleteResponseSchema.parse({
      deleted: rows.map((row) => row.path).sort(),
    });
  }

  async move(input: ProjectFileMoveRequestInput) {
    const request = ProjectFileMoveRequestSchema.parse(input);
    const source = this.#requireMeta(request.from);
    const destination = this.#getMeta(request.to);
    if (destination && !request.overwrite) {
      throw new Error(`Project file already exists: ${request.to}`);
    }
    if (destination) await this.delete({ path: request.to });
    if (!source.storage_key) {
      await this.workspace.mv(shellPath(request.from), shellPath(request.to));
    }
    const now = new Date().toISOString();
    this.#sql.exec(
      "DELETE FROM flary_workspace_file_meta WHERE path = ?",
      request.from,
    );
    this.#sql.exec(
      `INSERT INTO flary_workspace_file_meta
        (path, size, sha256, media_type, storage_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      request.to,
      source.size,
      source.sha256,
      source.media_type,
      source.storage_key,
      source.created_at,
      now,
    );
    return ProjectFileMutationResponseSchema.parse({
      file: this.#entry({ ...source, path: request.to, updated_at: now }),
    });
  }

  async copy(input: ProjectFileCopyRequestInput) {
    const request = ProjectFileCopyRequestSchema.parse(input);
    if (this.#getMeta(request.to) && !request.overwrite) {
      throw new Error(`Project file already exists: ${request.to}`);
    }
    const source = await this.read({ path: request.from, encoding: "base64" });
    return this.write({
      path: request.to,
      content: source.content,
      encoding: "base64",
      mediaType: source.file.mediaType,
    });
  }

  async edit(input: ProjectFileEditRequestInput) {
    const request = ProjectFileEditRequestSchema.parse(input);
    const current = await this.read({ path: request.path, encoding: "utf8" });
    if (
      request.expectedSha256 &&
      current.file.sha256 !== request.expectedSha256
    ) {
      throw new Error("File changed before the edit was applied");
    }
    let content = current.content;
    let replacementCount = 0;
    for (const edit of request.edits) {
      const matches = content.split(edit.oldText).length - 1;
      if (matches === 0) {
        throw new Error(`Edit text was not found in ${request.path}`);
      }
      if (!edit.replaceAll && matches > 1) {
        throw new Error(
          `Edit text is ambiguous in ${request.path}; use replaceAll or more context`,
        );
      }
      content = edit.replaceAll
        ? content.split(edit.oldText).join(edit.newText)
        : content.replace(edit.oldText, edit.newText);
      replacementCount += edit.replaceAll ? matches : 1;
    }
    const result = await this.write({
      path: request.path,
      content,
      encoding: "utf8",
      mediaType: current.file.mediaType,
    });
    return ProjectFileEditResponseSchema.parse({
      file: result.file,
      replacementCount,
    });
  }

  async applyPatch(input: ProjectFilePatchRequestInput) {
    const request = ProjectFilePatchRequestSchema.parse(input);
    const current = await this.read({ path: request.path, encoding: "utf8" });
    if (
      request.expectedSha256 &&
      current.file.sha256 !== request.expectedSha256
    ) {
      throw new Error("File changed before the patch was applied");
    }
    const applied = applyWorkspaceUnifiedPatch(current.content, request.patch, request.path);
    const result = await this.write({
      path: request.path,
      content: applied.content,
      encoding: "utf8",
      mediaType: current.file.mediaType,
    });
    return ProjectFilePatchResponseSchema.parse({
      file: result.file,
      hunkCount: applied.hunkCount,
    });
  }

  /** Return relative file paths matched by a safe workspace glob. */
  async glob(input: WorkspaceGlobRequestInput) {
    const request = WorkspaceGlobRequestSchema.parse(input);
    const paths = await this.stateBackend().glob(`/${request.pattern}`);
    return WorkspaceGlobResponseSchema.parse({
      paths: paths
        .map(relativeShellPath)
        .filter((path): path is string => path !== undefined)
        .slice(0, request.limit),
    });
  }

  /** Search text without exposing the Shell backend or absolute paths. */
  async grep(input: WorkspaceGrepRequestInput) {
    const request = WorkspaceGrepRequestSchema.parse(input);
    const results = await this.stateBackend().searchFiles(
      `/${request.pattern}`,
      request.query,
      {
        caseSensitive: request.caseSensitive,
        regex: request.regex,
        wholeWord: request.wholeWord,
        contextBefore: request.contextBefore,
        contextAfter: request.contextAfter,
        maxMatches: request.maxMatches,
      },
    );
    const files = [] as Array<{ path: string; matches: typeof results[number]["matches"] }>;
    for (const result of results) {
      const path = relativeShellPath(result.path);
      if (path) files.push({ path, matches: result.matches });
    }
    return WorkspaceGrepResponseSchema.parse({ files });
  }

  /** Diff one file against another file or proposed text. */
  async diff(input: WorkspaceDiffRequestInput) {
    const request = WorkspaceDiffRequestSchema.parse(input);
    const backend = this.stateBackend();
    const diff =
      request.newContent !== undefined
        ? await backend.diffContent(shellPath(request.path), request.newContent)
        : await backend.diff(
            shellPath(request.path),
            shellPath(request.compareToPath!),
          );
    return WorkspaceDiffResponseSchema.parse({
      path: request.path,
      compareToPath: request.compareToPath,
      diff,
    });
  }

  /** Apply multiple text edits in one serialized workspace operation. */
  async batchEdit(input: WorkspaceBatchEditRequestInput) {
    const request = WorkspaceBatchEditRequestSchema.parse(input);
    const originals = new Map<string, ProjectFileReadResponse>();
    for (const edit of request.edits) {
      if (!originals.has(edit.path)) {
        originals.set(
          edit.path,
          await this.read({ path: edit.path, encoding: "utf8" }),
        );
      }
    }

    const results = [] as Array<{
      path: string;
      file: ProjectFileMutationResponse["file"];
      replacementCount: number;
    }>;
    try {
      for (const edit of request.edits) {
        const result = await this.edit(edit);
        results.push({
          path: edit.path,
          file: result.file,
          replacementCount: result.replacementCount,
        });
      }
    } catch (error) {
      if (request.rollbackOnError) {
        for (const original of originals.values()) {
          await this.write({
            path: original.file.path,
            content: original.content,
            encoding: "utf8",
            mediaType: original.file.mediaType,
          }).catch(() => undefined);
        }
      }
      throw error;
    }

    return WorkspaceBatchEditResponseSchema.parse({
      results,
      totalReplacementCount: results.reduce(
        (total, result) => total + result.replacementCount,
        0,
      ),
    });
  }

  stateBackend(): StateBackend {
    return createWorkspaceStateBackend(this.workspace);
  }

  stateTools(): ToolProvider {
    return stateTools(this.workspace);
  }

  gitTools(options?: GitToolsOptions): ToolProvider {
    return gitTools(this.workspace, options);
  }

  #getMeta(path: string): WorkspaceFileRow | undefined {
    return this.#sql
      .exec<WorkspaceFileRow>(
        `SELECT path, size, sha256, media_type, storage_key, created_at, updated_at
           FROM flary_workspace_file_meta WHERE path = ?`,
        path,
      )
      .toArray()[0];
  }

  #requireMeta(path: string): WorkspaceFileRow {
    const row = this.#getMeta(path);
    if (!row) throw new Error(`Project file not found: ${path}`);
    return row;
  }

  #listMeta(): WorkspaceFileRow[] {
    return this.#sql
      .exec<WorkspaceFileRow>(
        `SELECT path, size, sha256, media_type, storage_key, created_at, updated_at
           FROM flary_workspace_file_meta ORDER BY path`,
      )
      .toArray();
  }

  private async readBytes(row: WorkspaceFileRow): Promise<Uint8Array | null> {
    if (!row.storage_key) {
      return this.workspace.readFileBytes(shellPath(row.path));
    }
    if (!this.#r2) {
      throw new Error("R2 is required to read this large workspace file");
    }
    const object = await this.#r2.get(row.storage_key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }

  private ensureStorageKeyColumn(): void {
    const columns = this.#sql
      .exec<{ name: string }>("PRAGMA table_info(flary_workspace_file_meta)")
      .toArray();
    if (!columns.some((column) => column.name === "storage_key")) {
      this.#sql.exec(
        "ALTER TABLE flary_workspace_file_meta ADD COLUMN storage_key TEXT",
      );
    }
  }

  #entry(row: WorkspaceFileRow) {
    return ProjectFileEntrySchema.parse({
      path: row.path,
      size: Number(row.size),
      sha256: row.sha256,
      mediaType: row.media_type,
      storage:
        row.storage_key || Number(row.size) > this.#inlineThreshold
          ? "r2"
          : "inline",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}

function shellPath(path: string): string {
  return `/${path}`;
}

function relativeShellPath(path: string): string | undefined {
  const relative = path.startsWith("/") ? path.slice(1) : path;
  return relative.length > 0 && !relative.includes("..") ? relative : undefined;
}

function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType.includes("json") ||
    mediaType.includes("javascript") ||
    mediaType.includes("typescript") ||
    mediaType.includes("xml") ||
    mediaType.includes("yaml")
  );
}
