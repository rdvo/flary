import {
  ConnectionCreateInputSchema,
  ConnectionSecretInputSchema,
  ProviderEncryptedCredentialHandoffSchema,
  ProviderOAuthCompleteInputSchema,
  ProviderOAuthStartInputSchema,
  type ConnectionCreateInputRaw,
  type ConnectionSecretInput,
  type ProviderOAuthCompleteInput,
  type ProviderEncryptedCredentialHandoff,
  type ProviderCredentialLifecycle,
  type ProviderOAuthSession,
  type ProviderOAuthStartInput,
} from "../contracts/index.js";
import {
  ProjectFileDeleteResponseSchema,
  ProjectFileEditResponseSchema,
  ProjectFileListResponseSchema,
  ProjectFileMutationResponseSchema,
  ProjectFileEntrySchema,
  ProjectFileReadResponseSchema,
  type ProjectFileDeleteRequestInput,
  type ProjectFileDeleteResponse,
  type ProjectFileEditRequestInput,
  type ProjectFileEditResponse,
  type ProjectFileListRequestInput,
  type ProjectFileListResponse,
  type ProjectFileMoveRequestInput,
  type ProjectFileMutationResponse,
  type ProjectFileReadRequest,
  type ProjectFileReadResponse,
  type ProjectFileWriteRequestInput,
} from "../contracts/filesystem.js";
import {
  WorkspaceDownloadTicketRequestSchema,
  WorkspaceTransferTicketResponseSchema,
  WorkspaceUploadTicketRequestSchema,
  type WorkspaceDownloadTicketRequestInput,
  type WorkspaceTransferTicketResponse,
  type WorkspaceUploadTicketRequestInput,
} from "../contracts/transfers.js";
import {
  ConnectionDetailResponseSchema,
  ConnectionResponseSchema,
  ConnectionsResponseSchema,
  ConnectionSecretResponseSchema,
  ProviderOAuthResponseSchema,
  ProviderCredentialHandoffResponseSchema,
  CreatePromptRolloutInputSchema,
  CreatePromptRolloutResponseSchema,
  PromptRevisionsResponseSchema,
  PromptRevisionSourceResponseSchema,
  PromptVariantsResponseSchema,
  SavePromptInputSchema,
  SavePromptResponseSchema,
} from "./schemas.js";
import type {
  Connection,
  ConnectionDetailResponse,
  ConnectionSecretMetadata,
  CreatePromptRolloutInput,
  PromptRevisionSummary,
  PromptRevisionSourceResponse,
  PromptVariantSummary,
  SavePromptInput,
  SavePromptResponse,
} from "./schemas.js";

export interface FlaryClientOptions {
  baseUrl: string;
  appId: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  /** API mount point. Flary protocol servers use `/v1`; Flary Cloud uses `/api`. */
  apiPrefix?: string;
}

export class FlaryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Flary request failed with HTTP ${status}.`);
    this.name = "FlaryHttpError";
  }
}

export class FlaryClient {
  private readonly baseUrl: string;
  private readonly apiPrefix: string;
  private readonly request: typeof globalThis.fetch;

  constructor(private readonly options: FlaryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiPrefix = `/${(options.apiPrefix ?? "/v1").replace(/^\/+|\/+$/g, "")}`;
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async savePrompt(input: SavePromptInput): Promise<SavePromptResponse> {
    const body = SavePromptInputSchema.parse(input);
    const response = await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(this.options.appId)}/prompts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return SavePromptResponseSchema.parse(response);
  }

  async listConnections(): Promise<Connection[]> {
    const response = await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(this.options.appId)}/connections`,
    );
    return ConnectionsResponseSchema.parse(response).connections;
  }

  async createConnection(input: ConnectionCreateInputRaw): Promise<Connection> {
    const body = ConnectionCreateInputSchema.parse(input);
    const response = await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(this.options.appId)}/connections`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return ConnectionResponseSchema.parse(response).connection;
  }

  async getConnection(connectionId: string): Promise<ConnectionDetailResponse> {
    const response = await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(
        this.options.appId,
      )}/connections/${encodeURIComponent(connectionId)}`,
    );
    return ConnectionDetailResponseSchema.parse(response);
  }

  async putConnectionSecret(
    connectionId: string,
    input: ConnectionSecretInput,
  ): Promise<ConnectionSecretMetadata> {
    const body = ConnectionSecretInputSchema.parse(input);
    const response = await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(
        this.options.appId,
      )}/connections/${encodeURIComponent(connectionId)}/secrets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return ConnectionSecretResponseSchema.parse(response).secret;
  }

  async deleteConnectionSecret(connectionId: string, secretName: string): Promise<void> {
    await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(
        this.options.appId,
      )}/connections/${encodeURIComponent(connectionId)}/secrets/${encodeURIComponent(secretName)}`,
      { method: "DELETE" },
    );
  }

  async deleteConnection(connectionId: string): Promise<void> {
    await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(
        this.options.appId,
      )}/connections/${encodeURIComponent(connectionId)}`,
      { method: "DELETE" },
    );
  }

  async disconnectSubscriptionConnection(connectionId: string): Promise<void> {
    await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(
        this.options.appId,
      )}/connections/${encodeURIComponent(connectionId)}/disconnect`,
      { method: "POST" },
    );
  }

  async startProviderOAuth(input: ProviderOAuthStartInput): Promise<ProviderOAuthSession> {
    const body = ProviderOAuthStartInputSchema.parse(input);
    const response = await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(this.options.appId)}/provider-oauth/start`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return ProviderOAuthResponseSchema.parse(response).oauth;
  }

  async getProviderOAuth(
    sessionId: string,
    options: { poll?: boolean } = {},
  ): Promise<ProviderOAuthSession> {
    const query = options.poll ? "?poll=true" : "";
    const response = await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(
        this.options.appId,
      )}/provider-oauth/${encodeURIComponent(sessionId)}${query}`,
    );
    return ProviderOAuthResponseSchema.parse(response).oauth;
  }

  async completeProviderOAuth(
    sessionId: string,
    input: ProviderOAuthCompleteInput,
  ): Promise<ProviderOAuthSession> {
    const body = ProviderOAuthCompleteInputSchema.parse(input);
    const response = await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(
        this.options.appId,
      )}/provider-oauth/${encodeURIComponent(sessionId)}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return ProviderOAuthResponseSchema.parse(response).oauth;
  }

  async cancelProviderOAuth(sessionId: string): Promise<ProviderOAuthSession> {
    const response = await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(
        this.options.appId,
      )}/provider-oauth/${encodeURIComponent(sessionId)}/cancel`,
      { method: "POST" },
    );
    return ProviderOAuthResponseSchema.parse(response).oauth;
  }

  async importEncryptedProviderCredential(
    input: ProviderEncryptedCredentialHandoff,
  ): Promise<ProviderCredentialLifecycle> {
    const body = ProviderEncryptedCredentialHandoffSchema.parse(input);
    const response = await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(this.options.appId)}/provider-oauth/handoff`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return ProviderCredentialHandoffResponseSchema.parse(response).credential;
  }

  async disconnectProviderOAuthConnection(connectionId: string): Promise<void> {
    await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(
        this.options.appId,
      )}/provider-oauth/connections/${encodeURIComponent(connectionId)}/disconnect`,
      { method: "POST" },
    );
  }

  async listPromptRevisions(slug: string): Promise<PromptRevisionSummary[]> {
    const response = await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(
        this.options.appId,
      )}/prompts/${encodeURIComponent(slug)}/revisions`,
    );
    return PromptRevisionsResponseSchema.parse(response).revisions;
  }

  async listPromptVariants(slug: string): Promise<PromptVariantSummary[]> {
    const response = await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(
        this.options.appId,
      )}/prompts/${encodeURIComponent(slug)}/variants`,
    );
    return PromptVariantsResponseSchema.parse(response).variants;
  }

  async getPromptRevisionSource(
    slug: string,
    revisionId: string,
  ): Promise<PromptRevisionSourceResponse> {
    const response = await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(
        this.options.appId,
      )}/prompts/${encodeURIComponent(slug)}/revisions/${encodeURIComponent(revisionId)}/source`,
    );
    return PromptRevisionSourceResponseSchema.parse(response);
  }

  async createPromptRollout(
    slug: string,
    input: CreatePromptRolloutInput,
  ): Promise<{ ok: true; rolloutId: string }> {
    const body = CreatePromptRolloutInputSchema.parse(input);
    const response = await this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(
        this.options.appId,
      )}/prompts/${encodeURIComponent(slug)}/variants`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return CreatePromptRolloutResponseSchema.parse(response);
  }

  async writeWorkspaceFile(
    projectId: string,
    workspaceId: string,
    input: ProjectFileWriteRequestInput,
  ): Promise<ProjectFileMutationResponse> {
    return ProjectFileMutationResponseSchema.parse(
      await this.workspaceFileRequest(projectId, workspaceId, "write", input),
    );
  }

  async readWorkspaceFile(
    projectId: string,
    workspaceId: string,
    input: ProjectFileReadRequest,
  ): Promise<ProjectFileReadResponse> {
    return ProjectFileReadResponseSchema.parse(
      await this.workspaceFileRequest(projectId, workspaceId, "read", input),
    );
  }

  async listWorkspaceFiles(
    projectId: string,
    workspaceId: string,
    input: ProjectFileListRequestInput = {},
  ): Promise<ProjectFileListResponse> {
    return ProjectFileListResponseSchema.parse(
      await this.workspaceFileRequest(projectId, workspaceId, "list", input),
    );
  }

  async editWorkspaceFile(
    projectId: string,
    workspaceId: string,
    input: ProjectFileEditRequestInput,
  ): Promise<ProjectFileEditResponse> {
    return ProjectFileEditResponseSchema.parse(
      await this.workspaceFileRequest(projectId, workspaceId, "edit", input),
    );
  }

  async moveWorkspaceFile(
    projectId: string,
    workspaceId: string,
    input: ProjectFileMoveRequestInput,
  ): Promise<ProjectFileMutationResponse> {
    return ProjectFileMutationResponseSchema.parse(
      await this.workspaceFileRequest(projectId, workspaceId, "move", input),
    );
  }

  async deleteWorkspaceFiles(
    projectId: string,
    workspaceId: string,
    input: ProjectFileDeleteRequestInput,
  ): Promise<ProjectFileDeleteResponse> {
    return ProjectFileDeleteResponseSchema.parse(
      await this.workspaceFileRequest(projectId, workspaceId, "delete", input),
    );
  }

  async statWorkspaceFile(
    projectId: string,
    workspaceId: string,
    path: string,
  ): Promise<ReturnType<typeof ProjectFileEntrySchema.parse>> {
    const response = await this.workspaceFileRequest(projectId, workspaceId, "stat", { path });
    return ProjectFileEntrySchema.parse((response as { file?: unknown }).file);
  }

  async createWorkspaceUploadTicket(
    projectId: string,
    workspaceId: string,
    input: WorkspaceUploadTicketRequestInput,
  ): Promise<WorkspaceTransferTicketResponse> {
    const body = WorkspaceUploadTicketRequestSchema.parse(input);
    return WorkspaceTransferTicketResponseSchema.parse(
      await this.fetchJson(this.workspaceTransferPath(projectId, workspaceId, "upload-ticket"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async createWorkspaceDownloadTicket(
    projectId: string,
    workspaceId: string,
    input: WorkspaceDownloadTicketRequestInput,
  ): Promise<WorkspaceTransferTicketResponse> {
    const body = WorkspaceDownloadTicketRequestSchema.parse(input);
    return WorkspaceTransferTicketResponseSchema.parse(
      await this.fetchJson(this.workspaceTransferPath(projectId, workspaceId, "download-ticket"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async uploadWorkspaceBytes(
    projectId: string,
    workspaceId: string,
    input: {
      path: string;
      bytes: Uint8Array | ArrayBuffer;
      mediaType: string;
      expiresInSeconds?: number;
    },
  ): Promise<ProjectFileMutationResponse> {
    const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
    const ticket = await this.createWorkspaceUploadTicket(projectId, workspaceId, {
      path: input.path,
      size: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      mediaType: input.mediaType,
      expiresInSeconds: input.expiresInSeconds,
    });
    if (!ticket.uploadUrl) throw new Error("The server did not return uploadUrl");
    const response = await this.fetchResponse(ticket.uploadUrl, {
      method: "PUT",
      body: bytes as unknown as BodyInit,
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw new FlaryHttpError(response.status, body);
    return ProjectFileMutationResponseSchema.parse(body);
  }

  async downloadWorkspaceBytes(
    projectId: string,
    workspaceId: string,
    path: string,
    expiresInSeconds?: number,
  ): Promise<{ bytes: Uint8Array; mediaType?: string; sha256?: string }> {
    const ticket = await this.createWorkspaceDownloadTicket(projectId, workspaceId, {
      path,
      expiresInSeconds,
    });
    if (!ticket.downloadUrl) {
      throw new Error("The server did not return downloadUrl");
    }
    const response = await this.fetchResponse(ticket.downloadUrl);
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new FlaryHttpError(response.status, body);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (ticket.size !== undefined && ticket.size !== bytes.byteLength) {
      throw new Error("Downloaded workspace bytes failed the size check");
    }
    if (ticket.sha256 && ticket.sha256 !== (await sha256Hex(bytes))) {
      throw new Error("Downloaded workspace bytes failed the SHA-256 check");
    }
    return {
      bytes,
      mediaType: ticket.mediaType,
      sha256: ticket.sha256,
    };
  }

  private workspaceFileRequest(
    projectId: string,
    workspaceId: string,
    operation: "write" | "read" | "stat" | "list" | "edit" | "move" | "delete",
    body: unknown,
  ): Promise<unknown> {
    return this.fetchJson(
      `${this.apiPrefix}/apps/${encodeURIComponent(
        this.options.appId,
      )}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(
        workspaceId,
      )}/files/${operation}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  private workspaceTransferPath(
    projectId: string,
    workspaceId: string,
    operation: "upload-ticket" | "download-ticket",
  ): string {
    return `${this.apiPrefix}/apps/${encodeURIComponent(
      this.options.appId,
    )}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(
      workspaceId,
    )}/files/${operation}`;
  }

  private async fetchJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (this.options.token) {
      headers.set("authorization", `Bearer ${this.options.token}`);
    }

    const response = await this.fetchResponse(path, { ...init, headers });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw new FlaryHttpError(response.status, body);
    return body;
  }

  private async fetchResponse(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.options.token) {
      headers.set("authorization", `Bearer ${this.options.token}`);
    }
    return this.request(path.startsWith("http") ? path : `${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
