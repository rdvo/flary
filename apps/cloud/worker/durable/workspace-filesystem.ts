import { z } from "zod";
import {
  ProjectFileDeleteRequestSchema,
  ProjectFileEditRequestSchema,
  ProjectFileListRequestSchema,
  ProjectFileMoveRequestSchema,
  ProjectFileReadRequestSchema,
  ProjectFileWriteRequestSchema,
  StorageScopeSchema,
  WorkspaceDownloadTicketRequestSchema,
  WorkspaceTransferTicketSchema,
  WorkspaceUploadTicketRequestSchema,
  type StorageScope,
  type WorkspaceTransferTicket,
} from "flary/contracts";
import { decodeWorkspaceFileContent, ShellWorkspace } from "flary/storage";

import type { Env } from "../env";

/**
 * Durable branch workspace backed by Cloudflare Shell.
 *
 * The object name includes the tenant and workspace identity. The request
 * headers are checked against the identity on first use and on every later
 * request so a stub cannot be reused for another tenant.
 */
export class WorkspaceFilesystem {
  #workspace?: ShellWorkspace;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const scope = this.requireScope(request);
      const workspace = this.getWorkspace(scope);
      const path = new URL(request.url).pathname;

      if (request.method === "GET" && path.endsWith("/health")) {
        return Response.json({
          ok: true,
          scope,
          workspace: await workspace.workspace.getWorkspaceInfo(),
        });
      }
      if (request.method === "POST" && path.endsWith("/upload-ticket")) {
        return Response.json(await this.createUploadTicket(workspace, request));
      }
      if (request.method === "POST" && path.endsWith("/download-ticket")) {
        return Response.json(
          await this.createDownloadTicket(workspace, request)
        );
      }
      if (request.method === "PUT" && path.endsWith("/upload")) {
        return this.upload(workspace, request);
      }
      if (request.method === "GET" && path.endsWith("/download")) {
        return this.download(workspace, request);
      }
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }

      const input = await request.json();
      if (path.endsWith("/write")) {
        return Response.json(
          await workspace.write(ProjectFileWriteRequestSchema.parse(input)),
          { status: 201 }
        );
      }
      if (path.endsWith("/read")) {
        return Response.json(
          await workspace.read(ProjectFileReadRequestSchema.parse(input))
        );
      }
      if (path.endsWith("/stat")) {
        const parsed = ProjectFileReadRequestSchema.parse(input);
        return Response.json({ file: await workspace.stat(parsed.path) });
      }
      if (path.endsWith("/list")) {
        return Response.json(
          await workspace.list(ProjectFileListRequestSchema.parse(input))
        );
      }
      if (path.endsWith("/delete")) {
        return Response.json(
          await workspace.delete(ProjectFileDeleteRequestSchema.parse(input))
        );
      }
      if (path.endsWith("/move")) {
        return Response.json(
          await workspace.move(ProjectFileMoveRequestSchema.parse(input))
        );
      }
      if (path.endsWith("/edit")) {
        return Response.json(
          await workspace.edit(ProjectFileEditRequestSchema.parse(input))
        );
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Workspace operation failed";
      return Response.json(
        {
          error: message,
          issues: error instanceof z.ZodError ? error.issues : undefined,
        },
        { status: workspaceErrorStatus(message, error) }
      );
    }
  }

  private async createUploadTicket(
    workspace: ShellWorkspace,
    request: Request
  ): Promise<WorkspaceTransferTicket> {
    const input = WorkspaceUploadTicketRequestSchema.parse(
      await request.json()
    );
    const ticket = this.createTicket(
      "upload",
      input.path,
      input.expiresInSeconds,
      {
        size: input.size,
        sha256: input.sha256,
        mediaType: input.mediaType,
      }
    );
    this.state.storage.sql.exec(
      `INSERT INTO flary_workspace_transfer_tokens
        (token, operation, path, size, sha256, media_type, expires_at)
       VALUES (?, 'upload', ?, ?, ?, ?, ?)`,
      ticket.token,
      input.path,
      input.size,
      input.sha256,
      input.mediaType,
      ticket.expiresAt
    );
    return WorkspaceTransferTicketSchema.parse(ticket);
  }

  private async createDownloadTicket(
    workspace: ShellWorkspace,
    request: Request
  ): Promise<WorkspaceTransferTicket> {
    const input = WorkspaceDownloadTicketRequestSchema.parse(
      await request.json()
    );
    const file = await workspace.stat(input.path);
    const ticket = this.createTicket(
      "download",
      input.path,
      input.expiresInSeconds,
      {
        size: file.size,
        sha256: file.sha256,
        mediaType: file.mediaType,
      }
    );
    this.state.storage.sql.exec(
      `INSERT INTO flary_workspace_transfer_tokens
        (token, operation, path, size, sha256, media_type, expires_at)
       VALUES (?, 'download', ?, ?, ?, ?, ?)`,
      ticket.token,
      input.path,
      file.size,
      file.sha256,
      file.mediaType,
      ticket.expiresAt
    );
    return WorkspaceTransferTicketSchema.parse(ticket);
  }

  private async upload(
    workspace: ShellWorkspace,
    request: Request
  ): Promise<Response> {
    const ticket = this.requireTicket(request, "upload");
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength !== ticket.size) {
      return Response.json(
        { error: "Upload size does not match the ticket" },
        { status: 409 }
      );
    }
    const result = await workspace.writeBytes({
      path: ticket.path,
      bytes,
      mediaType: ticket.media_type,
      expectedSha256: ticket.sha256,
    });
    this.deleteTicket(ticket.token);
    return Response.json(result, { status: 201 });
  }

  private async download(
    workspace: ShellWorkspace,
    request: Request
  ): Promise<Response> {
    const ticket = this.requireTicket(request, "download");
    const result = await workspace.read({
      path: ticket.path,
      encoding: "base64",
    });
    const bytes = decodeWorkspaceFileContent(result.content, "base64");
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "cache-control": "private, no-store",
        "content-length": String(bytes.byteLength),
        "content-type": result.file.mediaType,
        etag: `"${result.file.sha256}"`,
      },
    });
  }

  private createTicket(
    operation: "upload" | "download",
    path: string,
    expiresInSeconds: number,
    details: Pick<WorkspaceTransferTicket, "size" | "sha256" | "mediaType">
  ): WorkspaceTransferTicket {
    const expiresAt = new Date(
      Date.now() + expiresInSeconds * 1_000
    ).toISOString();
    return WorkspaceTransferTicketSchema.parse({
      token: `${crypto.randomUUID()}${crypto.randomUUID()}`,
      operation,
      path,
      expiresAt,
      ...details,
    });
  }

  private requireTicket(
    request: Request,
    operation: "upload" | "download"
  ): {
    token: string;
    operation: string;
    path: string;
    size: number;
    sha256: string;
    media_type: string;
    expires_at: string;
  } {
    const token = new URL(request.url).searchParams.get("ticket");
    if (!token) throw new Error("A transfer ticket is required");
    const row = this.state.storage.sql
      .exec<{
        token: string;
        operation: string;
        path: string;
        size: number;
        sha256: string;
        media_type: string;
        expires_at: string;
      }>(
        `SELECT token, operation, path, size, sha256, media_type, expires_at
           FROM flary_workspace_transfer_tokens WHERE token = ?`,
        token
      )
      .toArray()[0];
    if (!row || row.operation !== operation) {
      throw new Error("Transfer ticket is invalid");
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.deleteTicket(row.token);
      throw new Error("Transfer ticket has expired");
    }
    return row;
  }

  private deleteTicket(token: string): void {
    this.state.storage.sql.exec(
      "DELETE FROM flary_workspace_transfer_tokens WHERE token = ?",
      token
    );
  }

  private getWorkspace(scope: StorageScope): ShellWorkspace {
    if (!this.#workspace) {
      this.#workspace = new ShellWorkspace({
        sql: this.state.storage.sql,
        r2: this.env.WORKSPACE_BLOBS,
        scope,
        requireR2ForLargeFiles: this.env.APP_ENV === "production",
      });
    }
    return this.#workspace;
  }

  private requireScope(request: Request): StorageScope {
    const scope = StorageScopeSchema.parse({
      organizationId: request.headers.get("x-flary-organization-id"),
      appId: request.headers.get("x-flary-app-id"),
      projectId: request.headers.get("x-flary-project-id"),
      workspaceId: request.headers.get("x-flary-workspace-id"),
      branch: request.headers.get("x-flary-branch") ?? "main",
    });
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS flary_workspace_scope (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        organization_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT 'main',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flary_workspace_transfer_tokens (
        token TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        media_type TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS flary_workspace_transfer_expiry_idx
        ON flary_workspace_transfer_tokens(expires_at)`
    );
    try {
      this.state.storage.sql.exec(
        "ALTER TABLE flary_workspace_scope ADD COLUMN branch TEXT NOT NULL DEFAULT 'main'"
      );
    } catch {
      // The column already exists on current Durable Object databases.
    }
    const existing = this.state.storage.sql
      .exec<{
        organization_id: string;
        app_id: string;
        project_id: string;
        workspace_id: string;
        branch: string;
      }>(
        `SELECT organization_id, app_id, project_id, workspace_id, branch
           FROM flary_workspace_scope WHERE singleton = 1`
      )
      .toArray()[0];
    const storedScope = existing
      ? StorageScopeSchema.parse({
          organizationId: existing.organization_id,
          appId: existing.app_id,
          projectId: existing.project_id,
          workspaceId: existing.workspace_id,
          branch: existing.branch,
        })
      : undefined;
    if (storedScope) {
      if (
        storedScope.organizationId !== scope.organizationId ||
        storedScope.appId !== scope.appId ||
        storedScope.projectId !== scope.projectId ||
        storedScope.workspaceId !== scope.workspaceId ||
        storedScope.branch !== scope.branch
      ) {
        throw new Error("Workspace scope does not match this Durable Object");
      }
      return storedScope;
    }
    this.state.storage.sql.exec(
      `INSERT INTO flary_workspace_scope
        (singleton, organization_id, app_id, project_id, workspace_id, branch, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
      scope.organizationId,
      scope.appId,
      scope.projectId,
      scope.workspaceId,
      scope.branch,
      new Date().toISOString()
    );
    return scope;
  }
}

function workspaceErrorStatus(message: string, error: unknown): number {
  if (error instanceof z.ZodError) return 400;
  if (message.includes("not found")) return 404;
  if (
    message.includes("already exists") ||
    message.includes("changed before") ||
    message.includes("expectedSha256") ||
    message.includes("scope does not match")
  ) {
    return 409;
  }
  if (
    message.includes("integrity check") ||
    message.includes("Stored bytes are missing")
  ) {
    return 500;
  }
  return 400;
}
