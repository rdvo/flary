import {
  RecallDocumentSchema,
  RecallOpenRequestSchema,
  RecallSearchRequestSchema,
  RecallSearchResponseSchema,
  type RecallDocument,
  type RecallDocumentInput,
  type RecallOpenRequest,
  type RecallResult,
  type RecallSearchRequest,
} from "../contracts/recall.js";
import type { RecallScope } from "../contracts/recall.js";

export interface RecallIndex {
  upsert(documents: readonly RecallDocumentInput[]): Promise<void>;
  delete(ids: readonly string[]): Promise<void>;
  search(
    request: RecallSearchRequest,
  ): Promise<ReturnType<typeof RecallSearchResponseSchema.parse>>;
  open(request: RecallOpenRequest): Promise<RecallDocument | undefined>;
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function tokens(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9_:-]+/i)
    .filter(Boolean);
}

function scopeContains(parent: RecallScope, child: RecallScope): boolean {
  switch (parent.kind) {
    case "session":
      return child.sessionId === parent.sessionId;
    case "project":
      return child.appId === parent.appId && child.projectId === parent.projectId;
    case "app":
      return child.appId === parent.appId;
    case "organization":
      return child.organizationId === parent.organizationId;
  }
}

function makeSnippet(content: string, query: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  const position = normalize(compact).indexOf(normalize(query));
  if (compact.length <= 320) return compact;
  if (position < 0) return compact.slice(0, 317) + "...";
  const start = Math.max(0, position - 110);
  const end = Math.min(compact.length, start + 320);
  return (start > 0 ? "..." : "") + compact.slice(start, end) + (end < compact.length ? "..." : "");
}

function scoreDocument(content: string, query: string): number {
  const normalizedContent = normalize(content);
  const normalizedQuery = normalize(query);
  if (normalizedContent.includes(normalizedQuery)) return 1;
  const queryTokens = new Set(tokens(query));
  const contentTokens = new Set(tokens(content));
  if (queryTokens.size === 0) return 0;
  let matches = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) matches += 1;
  }
  return matches / queryTokens.size;
}

function resultFor(
  document: RecallDocument,
  request: RecallSearchRequest,
  score: number,
): RecallResult {
  const matchType = normalize(document.content).includes(normalize(request.query))
    ? "exact"
    : request.mode === "semantic"
      ? "semantic"
      : "hybrid";
  return {
    id: document.id,
    snippet: makeSnippet(document.content, request.query),
    reference: document.reference,
    score,
    matchType,
    metadata: document.metadata,
  };
}

export class InMemoryRecallIndex implements RecallIndex {
  readonly #documents = new Map<string, RecallDocument>();

  constructor(documents: readonly RecallDocumentInput[] = []) {
    for (const document of documents) {
      const parsed = RecallDocumentSchema.parse(document);
      this.#documents.set(parsed.id, parsed);
    }
  }

  async upsert(documents: readonly RecallDocumentInput[]): Promise<void> {
    for (const document of documents) {
      const parsed = RecallDocumentSchema.parse(document);
      this.#documents.set(parsed.id, parsed);
    }
  }

  async delete(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.#documents.delete(id);
  }

  async search(requestInput: RecallSearchRequest) {
    const request = RecallSearchRequestSchema.parse(requestInput);
    const kinds = request.kinds ? new Set(request.kinds) : undefined;
    const results = [...this.#documents.values()]
      .filter((document) => !document.deleted)
      .filter((document) => scopeContains(request.scope, document.scope))
      .filter((document) => !kinds || kinds.has(document.kind))
      .map((document) => ({
        document,
        score: scoreDocument(document.content, request.query),
        exact: normalize(document.content).includes(normalize(request.query)),
      }))
      .filter((item) => (request.mode === "exact" ? item.exact : item.score > 0))
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.document.createdAt.localeCompare(left.document.createdAt),
      )
      .slice(0, request.limit)
      .map(({ document, score }) => resultFor(document, request, score));
    return RecallSearchResponseSchema.parse({ results });
  }

  async open(requestInput: RecallOpenRequest): Promise<RecallDocument | undefined> {
    const request = RecallOpenRequestSchema.parse(requestInput);
    const id = request.id ?? request.reference?.id;
    if (!id) return undefined;
    const document = this.#documents.get(id);
    if (!document || document.deleted) return undefined;
    if (!scopeContains(request.scope, document.scope)) return undefined;
    return RecallDocumentSchema.parse(document);
  }

  documents(): RecallDocument[] {
    return [...this.#documents.values()].map((document) => RecallDocumentSchema.parse(document));
  }
}

export class RecallService {
  constructor(readonly index: RecallIndex) {}

  search(request: RecallSearchRequest) {
    return this.index.search(request);
  }

  open(request: RecallOpenRequest) {
    return this.index.open(request);
  }
}

type TurbopufferFilter = [string, string, unknown];

function recallFilters(scope: RecallScope, kinds?: readonly string[]): TurbopufferFilter[] {
  const filters: TurbopufferFilter[] = [];
  if (scope.organizationId) {
    filters.push(["organization_id", "Eq", scope.organizationId]);
  }
  if (scope.appId) filters.push(["app_id", "Eq", scope.appId]);
  if (scope.projectId) filters.push(["project_id", "Eq", scope.projectId]);
  if (scope.sessionId) filters.push(["session_id", "Eq", scope.sessionId]);
  if (kinds) filters.push(["kind", "In", kinds]);
  return filters;
}

export interface TurbopufferRecallIndexOptions {
  baseUrl: string;
  apiKey: string;
  namespace: string;
  fetch?: typeof globalThis.fetch;
  embed?: (query: string) => Promise<readonly number[]>;
}

type TurbopufferRow = {
  id: string;
  score?: number;
  $dist?: number;
  attributes?: Record<string, unknown>;
};

// This adapter is deliberately small. Artifacts remain the source of truth;
// Turbopuffer is only a replaceable derived index.
export class TurbopufferRecallIndex implements RecallIndex {
  private readonly request: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: TurbopufferRecallIndexOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.request = options.fetch ?? globalThis.fetch;
  }

  async upsert(documents: readonly RecallDocumentInput[]): Promise<void> {
    const rows = documents.map((document) => {
      const parsed = RecallDocumentSchema.parse(document);
      return {
        id: parsed.id,
        attributes: {
          content: parsed.content,
          kind: parsed.kind,
          organization_id: parsed.scope.organizationId,
          app_id: parsed.scope.appId,
          project_id: parsed.scope.projectId,
          session_id: parsed.scope.sessionId,
          reference_json: JSON.stringify(parsed.reference),
          metadata_json: JSON.stringify(parsed.metadata ?? {}),
          created_at: parsed.createdAt,
        },
        ...(parsed.vector ? { vector: parsed.vector } : {}),
      };
    });
    await this.sendWrite({
      upsert_rows: rows,
      schema: {
        content: { type: "string", full_text_search: true },
        kind: { type: "string" },
        organization_id: { type: "string" },
        app_id: { type: "string" },
        project_id: { type: "string" },
        session_id: { type: "string" },
        reference_json: { type: "string" },
        metadata_json: { type: "string" },
        created_at: { type: "string" },
      },
    });
  }

  async delete(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.sendWrite({ delete_ids: [...ids] });
  }

  async search(requestInput: RecallSearchRequest) {
    const request = RecallSearchRequestSchema.parse(requestInput);
    const filters = recallFilters(request.scope, request.kinds);
    const includeAttributes = ["content", "kind", "reference_json", "metadata_json"];
    const vector =
      request.mode !== "exact" && this.options.embed
        ? await this.options.embed(request.query)
        : undefined;
    const queryLimit = Math.max(request.limit * 2, 20);
    const ordinaryQuery: Record<string, unknown> = {
      limit: queryLimit,
      include_attributes: includeAttributes,
      rank_by:
        request.mode === "semantic" && vector
          ? ["vector", "ANN", [...vector]]
          : ["content", "BM25", request.query],
    };
    if (filters.length === 1) ordinaryQuery.filters = filters[0];
    if (filters.length > 1) ordinaryQuery.filters = ["And", ...filters];
    const payload =
      request.mode === "hybrid" && vector
        ? {
            queries: [
              {
                ...ordinaryQuery,
                rank_by: ["vector", "ANN", [...vector]],
              },
              {
                ...ordinaryQuery,
                rank_by: ["content", "BM25", request.query],
              },
            ],
            rerank_by: ["RRF"],
          }
        : ordinaryQuery;
    const body = await this.sendQuery(payload);
    const rows = Array.isArray(body.rows)
      ? (body.rows as TurbopufferRow[])
      : Array.isArray(body.results)
        ? (((body.results[0] as { rows?: unknown[] } | undefined)?.rows ?? []) as TurbopufferRow[])
        : [];
    const results = rows.map((row) => {
      const attributes = row.attributes ?? {};
      const reference = JSON.parse(String(attributes.reference_json ?? "{}"));
      return {
        id: String(row.id),
        snippet: makeSnippet(String(attributes.content ?? ""), request.query),
        reference,
        score: Number(row.score ?? row["$dist"] ?? 0),
        matchType:
          request.mode === "exact" ? "exact" : request.mode === "semantic" ? "semantic" : "hybrid",
        metadata: JSON.parse(String(attributes.metadata_json ?? "{}")),
      };
    });
    return RecallSearchResponseSchema.parse({ results });
  }

  async open(requestInput: RecallOpenRequest): Promise<RecallDocument | undefined> {
    const request = RecallOpenRequestSchema.parse(requestInput);
    const id = request.id ?? request.reference?.id;
    if (!id) return undefined;
    const scopeFilters = recallFilters(request.scope);
    const filters = [["id", "Eq", id] as [string, string, unknown], ...scopeFilters];
    const body = await this.sendQuery({
      limit: 1,
      filters: filters.length === 1 ? filters[0] : ["And", ...filters],
      rank_by: ["id", "asc"],
      include_attributes: [
        "content",
        "kind",
        "organization_id",
        "app_id",
        "project_id",
        "session_id",
        "reference_json",
        "metadata_json",
        "created_at",
      ],
    });
    const row = Array.isArray(body.rows) ? (body.rows as TurbopufferRow[])[0] : undefined;
    if (!row) return undefined;
    const attributes = row.attributes ?? {};
    const document = RecallDocumentSchema.parse({
      id: String(row.id),
      content: String(attributes.content ?? ""),
      kind: attributes.kind,
      scope: {
        kind: attributes.session_id ? "session" : "app",
        organizationId: attributes.organization_id,
        appId: attributes.app_id,
        projectId: attributes.project_id,
        sessionId: attributes.session_id,
      },
      reference: JSON.parse(String(attributes.reference_json ?? "{}")),
      metadata: JSON.parse(String(attributes.metadata_json ?? "{}")),
      createdAt: attributes.created_at,
    });
    return scopeContains(request.scope, document.scope) ? document : undefined;
  }

  private async sendWrite(body: Record<string, unknown>): Promise<void> {
    await this.sendRequest("", body);
  }

  private async sendQuery(body: Record<string, unknown>): Promise<{
    rows?: unknown[];
    results?: Array<{ rows?: unknown[] }>;
  }> {
    return this.sendRequest("/query", body);
  }

  private async sendRequest(
    suffix: string,
    body: Record<string, unknown>,
  ): Promise<{
    rows?: unknown[];
    results?: Array<{ rows?: unknown[] }>;
  }> {
    const response = await this.request(
      this.baseUrl + "/v2/namespaces/" + encodeURIComponent(this.options.namespace) + suffix,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + this.options.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw new Error("Turbopuffer recall request failed with HTTP " + response.status);
    }
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object") return {};
    return payload as { rows?: unknown[] };
  }
}
export { ArtifactRecallIndexer } from "./artifacts.js";
