import {
  ProjectDirectoryPathSchema,
  ProjectFileDeleteRequestSchema,
  ProjectFileEditRequestSchema,
  ProjectFileListRequestSchema,
  ProjectFileMoveRequestSchema,
  ProjectFilePathSchema,
  ProjectFileReadRequestSchema,
  ProjectFileWriteRequestSchema,
  ProjectFileMutationResponseSchema,
  ProjectFileReadResponseSchema,
  ProjectFileDeleteResponseSchema,
  ProjectFileEditResponseSchema,
  ProjectFileEntrySchema,
  ProjectFileListResponseSchema,
  WorkspaceBatchEditRequestSchema,
  WorkspaceBatchEditResponseSchema,
  WorkspaceDiffRequestSchema,
  WorkspaceDiffResponseSchema,
  WorkspaceGlobRequestSchema,
  WorkspaceGlobResponseSchema,
  WorkspaceGrepRequestSchema,
  WorkspaceGrepResponseSchema,
  type ProjectFileEntry,
} from "../contracts/index.js";
import type {
  FlaryR2Source,
  FlaryStepContext,
  FlaryToolConnection,
} from "./types.js";
import {
  decodeWorkspaceFileContent,
  workspaceBytesToBase64,
  workspaceSha256Hex,
} from "../storage/workspace-codec.js";

/** The small structural surface shared by Cloudflare R2 and S3 adapters. */
export interface FlaryR2Bucket {
  get(key: string): Promise<FlaryR2Object | null>;
  put(key: string, value: unknown, options?: Record<string, unknown>): Promise<unknown>;
  delete(key: string | readonly string[]): Promise<unknown>;
  list(options?: Record<string, unknown>): Promise<FlaryR2ListResult>;
}

interface FlaryR2Object {
  readonly key?: string;
  readonly size?: number;
  readonly uploaded?: Date | string;
  readonly etag?: string;
  readonly customMetadata?: Record<string, string>;
  readonly httpMetadata?: { readonly contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface FlaryR2ListResult {
  readonly objects?: readonly FlaryR2Object[];
  readonly truncated?: boolean;
  readonly cursor?: string;
}

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_LIST_FILES = 10_000;

/**
 * Resolve a trusted R2 binding into tenant-scoped file tools.
 *
 * The bucket and prefix are selected by the server. They never enter the
 * model-visible tool input, which prevents a model from crossing tenants.
 */
export async function createR2FileConnection<TBindings>(
  source: FlaryR2Source,
  bindings: TBindings,
  context: FlaryStepContext<TBindings>,
): Promise<FlaryToolConnection> {
  if (!source.binding) {
    throw new Error(
      `R2 source '${source.namespace}' needs a host resolver for connection '${source.connection ?? "unknown"}'.`,
    );
  }
  const record = isRecord(bindings) ? bindings : undefined;
  const bucket = record?.[source.binding];
  if (!isR2Bucket(bucket)) {
    throw new Error(
      `R2 binding '${source.binding}' is not available for source '${source.namespace}'.`,
    );
  }
  const tenantId = context.identity?.tenantId;
  if (!tenantId) {
    throw new Error("An authenticated tenant is required for an R2 file source.");
  }
  const prefix = resolvePrefix(source.prefix ?? "", tenantId);
  return new R2FileConnection(bucket, prefix, source.access ?? "read-write");
}

class R2FileConnection implements FlaryToolConnection {
  descriptors!: FlaryToolConnection["descriptors"];

  constructor(
    private readonly bucket: FlaryR2Bucket,
    private readonly basePrefix: string,
    private readonly access: "read" | "read-write",
  ) {
    this.initializeDescriptors();
  }

  private initializeDescriptors(): void {
    const values = [
      descriptor("read", "Read one file from the customer R2 prefix", "read"),
      descriptor("list", "List files in the customer R2 prefix", "read"),
      descriptor("stat", "Read safe metadata for one R2 file", "read"),
      descriptor("glob", "Find files by a safe glob", "read"),
      descriptor("grep", "Search text files in the customer R2 prefix", "read"),
      descriptor("diff", "Compare a file with another file or proposed content", "read"),
      ...(this.access === "read-write"
        ? [
            descriptor("write", "Write one file to the customer R2 prefix", "write"),
            descriptor("edit", "Apply exact text edits to one R2 file", "write"),
            descriptor("batchEdit", "Apply several text edits to R2 files", "write"),
            descriptor("move", "Move one file inside the customer R2 prefix", "write"),
            descriptor("delete", "Delete one file or prefix from R2", "write"),
          ]
        : []),
    ];
    this.descriptors = values;
  }

  async call(name: string, input: unknown): Promise<unknown> {
    switch (name) {
      case "read": return this.read(input);
      case "list": return this.list(input);
      case "stat": return this.stat(input);
      case "glob": return this.glob(input);
      case "grep": return this.grep(input);
      case "diff": return this.diff(input);
      case "write": return this.write(input);
      case "edit": return this.edit(input);
      case "batchEdit": return this.batchEdit(input);
      case "move": return this.move(input);
      case "delete": return this.remove(input);
      default: throw new Error(`R2 file tool '${name}' is not available`);
    }
  }

  private ensureWritable(): void {
    if (this.access !== "read-write") {
      throw new Error("This R2 file source is read-only");
    }
  }

  private key(path: string): string {
    const parsed = ProjectFilePathSchema.parse(path);
    return this.basePrefix ? `${this.basePrefix}${parsed}` : parsed;
  }

  private directoryKey(path: string): string {
    const parsed = ProjectDirectoryPathSchema.parse(path);
    if (!parsed) return this.basePrefix;
    return this.basePrefix ? `${this.basePrefix}${parsed}/` : `${parsed}/`;
  }

  private path(key: string): string | undefined {
    if (this.basePrefix) {
      if (!key.startsWith(this.basePrefix)) return undefined;
      const relative = key.slice(this.basePrefix.length);
      return relative && ProjectFilePathSchema.safeParse(relative).success
        ? relative
        : undefined;
    }
    return ProjectFilePathSchema.safeParse(key).success ? key : undefined;
  }

  private async readObject(path: string): Promise<{
    readonly bytes: Uint8Array;
    readonly entry: ProjectFileEntry;
  }> {
    const key = this.key(path);
    const object = await this.bucket.get(key);
    if (!object) throw new Error(`File not found: ${path}`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error(`File exceeds the ${MAX_FILE_BYTES} byte R2 file limit`);
    }
    return {
      bytes,
      entry: await this.entry(path, object, bytes),
    };
  }

  private async entry(
    path: string,
    object: FlaryR2Object,
    bytes?: Uint8Array,
  ): Promise<ProjectFileEntry> {
    const metadataHash = object.customMetadata?.sha256;
    const sha256 = metadataHash && /^[0-9a-f]{64}$/.test(metadataHash)
      ? metadataHash
      : await workspaceSha256Hex(bytes ?? new Uint8Array(await object.arrayBuffer()));
    const uploaded = object.uploaded instanceof Date
      ? object.uploaded.toISOString()
      : typeof object.uploaded === "string" && !Number.isNaN(Date.parse(object.uploaded))
        ? new Date(object.uploaded).toISOString()
        : new Date().toISOString();
    return ProjectFileEntrySchema.parse({
      path,
      size: object.size ?? bytes?.byteLength ?? 0,
      sha256,
      mediaType:
        object.httpMetadata?.contentType ??
        object.customMetadata?.mediaType ??
        mediaTypeFor(path),
      storage: "r2",
      createdAt: uploaded,
      updatedAt: uploaded,
    });
  }

  private async read(input: unknown) {
    const request = ProjectFileReadRequestSchema.parse(input);
    const result = await this.readObject(request.path);
    const encoding = request.encoding ??
      (result.entry.mediaType.startsWith("text/") ||
      /(?:json|javascript|typescript|xml|svg|css|html)/i.test(result.entry.mediaType)
        ? "utf8"
        : "base64");
    const content = encoding === "utf8"
      ? new TextDecoder("utf-8", { fatal: true }).decode(result.bytes)
      : workspaceBytesToBase64(result.bytes);
    return ProjectFileReadResponseSchema.parse({
      file: result.entry,
      content,
      encoding,
    });
  }

  private async stat(input: unknown) {
    const path = typeof input === "string"
      ? input
      : isRecord(input) && typeof input.path === "string"
        ? input.path
        : "";
    return (await this.readObject(ProjectFilePathSchema.parse(path))).entry;
  }

  private async list(input: unknown = {}) {
    const request = ProjectFileListRequestSchema.parse(input);
    const objects = await this.listObjects(this.directoryKey(request.prefix), request.limit, !request.recursive);
    const files: ProjectFileEntry[] = [];
    for (const object of objects) {
      const key = object.key;
      const path = typeof key === "string" ? this.path(key) : undefined;
      if (!path) continue;
      files.push(await this.entryForListedObject(path, object));
      if (files.length >= request.limit) break;
    }
    return ProjectFileListResponseSchema.parse({ files });
  }

  private async glob(input: unknown) {
    const request = WorkspaceGlobRequestSchema.parse(input);
    const files = await this.list({ prefix: "", recursive: true, limit: MAX_LIST_FILES });
    return WorkspaceGlobResponseSchema.parse({
      paths: files.files
        .map((file) => file.path)
        .filter((path) => matchGlob(path, request.pattern))
        .slice(0, request.limit),
    });
  }

  private async grep(input: unknown) {
    const request = WorkspaceGrepRequestSchema.parse(input);
    const files = await this.list({ prefix: "", recursive: true, limit: MAX_LIST_FILES });
    const results: Array<{ path: string; matches: Array<Record<string, unknown>> }> = [];
    const pattern = request.regex ? new RegExp(request.query, request.caseSensitive ? "g" : "gi") : undefined;
    for (const file of files.files) {
      if (!matchGlob(file.path, request.pattern)) continue;
      let content: string;
      try {
        content = (await this.read({ path: file.path, encoding: "utf8" })).content;
      } catch {
        continue;
      }
      const lines = content.split("\n");
      const matches: Array<Record<string, unknown>> = [];
      for (let index = 0; index < lines.length && matches.length < request.maxMatches; index += 1) {
        const lineText = lines[index] ?? "";
        const found = pattern
          ? pattern.test(lineText)
          : (request.wholeWord
            ? new RegExp(`\\b${escapeRegExp(request.query)}\\b`, request.caseSensitive ? "" : "i").test(lineText)
            : (request.caseSensitive ? lineText.includes(request.query) : lineText.toLowerCase().includes(request.query.toLowerCase())));
        if (!found) continue;
        const column = pattern ? Math.max(0, lineText.search(pattern)) : Math.max(0, (request.caseSensitive ? lineText : lineText.toLowerCase()).indexOf(request.caseSensitive ? request.query : request.query.toLowerCase()));
        matches.push({
          line: index + 1,
          column: column + 1,
          match: lineText.slice(Math.max(0, column), Math.max(0, column) + request.query.length),
          lineText,
          ...(request.contextBefore > 0 ? { beforeLines: lines.slice(Math.max(0, index - request.contextBefore), index) } : {}),
          ...(request.contextAfter > 0 ? { afterLines: lines.slice(index + 1, index + 1 + request.contextAfter) } : {}),
        });
      }
      if (matches.length > 0) results.push({ path: file.path, matches });
      if (results.reduce((sum, item) => sum + item.matches.length, 0) >= request.maxMatches) break;
    }
    return WorkspaceGrepResponseSchema.parse({ files: results });
  }

  private async diff(input: unknown) {
    const request = WorkspaceDiffRequestSchema.parse(input);
    const current = (await this.read({ path: request.path, encoding: "utf8" })).content;
    const target = request.newContent ?? (await this.read({ path: request.compareToPath!, encoding: "utf8" })).content;
    return WorkspaceDiffResponseSchema.parse({
      path: request.path,
      ...(request.compareToPath ? { compareToPath: request.compareToPath } : {}),
      diff: simpleDiff(current, target),
    });
  }

  private async write(input: unknown) {
    this.ensureWritable();
    const request = ProjectFileWriteRequestSchema.parse(input);
    const bytes = decodeWorkspaceFileContent(request.content, request.encoding);
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("R2 file is too large");
    if (request.expectedSha256) {
      const current = await this.readObject(request.path).catch(() => undefined);
      if (current && current.entry.sha256 !== request.expectedSha256) {
        throw new Error("File changed before the write was applied");
      }
    }
    const sha256 = await workspaceSha256Hex(bytes);
    await this.bucket.put(this.key(request.path), bytes, {
      httpMetadata: { contentType: request.mediaType },
      customMetadata: { sha256, mediaType: request.mediaType },
    });
    const object = await this.bucket.get(this.key(request.path));
    if (!object) throw new Error("R2 did not return the written file");
    return ProjectFileMutationResponseSchema.parse({
      file: await this.entry(request.path, object, bytes),
    });
  }

  private async edit(input: unknown) {
    this.ensureWritable();
    const request = ProjectFileEditRequestSchema.parse(input);
    const current = await this.read({ path: request.path, encoding: "utf8" });
    if (request.expectedSha256 && current.file.sha256 !== request.expectedSha256) {
      throw new Error("File changed before the edit was applied");
    }
    let content = current.content;
    let replacementCount = 0;
    for (const edit of request.edits) {
      const matches = content.split(edit.oldText).length - 1;
      if (matches === 0) throw new Error(`Edit text was not found in ${request.path}`);
      if (!edit.replaceAll && matches > 1) throw new Error(`Edit text is ambiguous in ${request.path}`);
      content = edit.replaceAll ? content.split(edit.oldText).join(edit.newText) : content.replace(edit.oldText, edit.newText);
      replacementCount += edit.replaceAll ? matches : 1;
    }
    const result = await this.write({ path: request.path, content, encoding: "utf8", mediaType: current.file.mediaType, expectedSha256: current.file.sha256 });
    return ProjectFileEditResponseSchema.parse({ ...result, replacementCount });
  }

  private async batchEdit(input: unknown) {
    this.ensureWritable();
    const request = WorkspaceBatchEditRequestSchema.parse(input);
    const originals = new Map<string, { content: string; mediaType: string; sha256: string }>();
    for (const edit of request.edits) {
      if (!originals.has(edit.path)) {
        const original = await this.read({ path: edit.path, encoding: "utf8" });
        originals.set(edit.path, { content: original.content, mediaType: original.file.mediaType, sha256: original.file.sha256 });
      }
    }
    const results: Array<{ path: string; file: ProjectFileEntry; replacementCount: number }> = [];
    try {
      for (const edit of request.edits) {
        const result = await this.edit(edit);
        results.push({ path: edit.path, file: result.file, replacementCount: result.replacementCount });
      }
    } catch (error) {
      if (request.rollbackOnError) {
        for (const [path, original] of originals) {
          await this.write({ path, content: original.content, encoding: "utf8", mediaType: original.mediaType }).catch(() => undefined);
        }
      }
      throw error;
    }
    return WorkspaceBatchEditResponseSchema.parse({
      results,
      totalReplacementCount: results.reduce((total, result) => total + result.replacementCount, 0),
    });
  }

  private async move(input: unknown) {
    this.ensureWritable();
    const request = ProjectFileMoveRequestSchema.parse(input);
    const current = await this.read({ path: request.from, encoding: "base64" });
    if (!request.overwrite) {
      const existing = await this.stat(request.to).catch(() => undefined);
      if (existing) throw new Error(`File already exists: ${request.to}`);
    }
    const result = await this.write({ path: request.to, content: current.content, encoding: "base64", mediaType: current.file.mediaType });
    await this.bucket.delete(this.key(request.from));
    return ProjectFileMutationResponseSchema.parse(result);
  }

  private async remove(input: unknown) {
    this.ensureWritable();
    const request = ProjectFileDeleteRequestSchema.parse(input);
    const prefix = this.directoryKey(request.path);
    const keys = request.recursive
      ? (await this.listObjects(prefix, MAX_LIST_FILES, false)).map((object) => object.key).filter((key): key is string => typeof key === "string")
      : [this.key(ProjectFilePathSchema.parse(request.path))];
    const existing = [] as string[];
    for (const key of keys) {
      if (await this.bucket.get(key)) existing.push(key);
    }
    if (existing.length > 0) await this.bucket.delete(existing);
    return ProjectFileDeleteResponseSchema.parse({
      deleted: existing.map((key) => this.path(key)).filter((path): path is string => Boolean(path)).sort(),
    });
  }

  private async listObjects(prefix: string, limit: number, nonRecursive: boolean): Promise<FlaryR2Object[]> {
    const objects: FlaryR2Object[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.bucket.list({
        prefix,
        limit: Math.min(limit, MAX_LIST_FILES),
        ...(nonRecursive ? { delimiter: "/" } : {}),
        ...(cursor ? { cursor } : {}),
      });
      objects.push(...(result.objects ?? []));
      cursor = result.truncated && result.cursor ? result.cursor : undefined;
    } while (cursor && objects.length < limit);
    return objects.slice(0, limit);
  }

  private async entryForListedObject(
    path: string,
    object: FlaryR2Object,
  ): Promise<ProjectFileEntry> {
    if (object.customMetadata?.sha256 && /^[0-9a-f]{64}$/.test(object.customMetadata.sha256)) {
      return this.entry(path, object);
    }
    const key = object.key;
    if (!key) throw new Error(`R2 list returned an object without a key for ${path}`);
    const body = await this.bucket.get(key);
    if (!body) throw new Error(`R2 object disappeared while listing ${path}`);
    const bytes = new Uint8Array(await body.arrayBuffer());
    return this.entry(path, body, bytes);
  }
}

function descriptor(
  name: string,
  description: string,
  operation: "read" | "write",
): FlaryToolConnection["descriptors"][number] {
  return {
    name,
    description,
    operation,
    requiresApproval: operation === "write",
    inputSchema: { type: "object", additionalProperties: true },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isR2Bucket(value: unknown): value is FlaryR2Bucket {
  return isRecord(value) &&
    typeof value.get === "function" &&
    typeof value.put === "function" &&
    typeof value.delete === "function" &&
    typeof value.list === "function";
}

function resolvePrefix(prefix: string, tenantId: string): string {
  const value = prefix.replaceAll("{tenantId}", tenantId).replace(/^\/+|\/+$/g, "");
  if (value.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("R2 prefixes cannot contain . or .. segments");
  }
  return value ? `${value}/` : "";
}

function mediaTypeFor(path: string): string {
  const extension = path.toLowerCase().split(".").at(-1);
  return ({
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "text/javascript",
    ts: "text/typescript",
    json: "application/json",
    md: "text/markdown",
    txt: "text/plain",
    svg: "image/svg+xml",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchGlob(path: string, pattern: string): boolean {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(character);
    }
  }
  return new RegExp(`^${source}$`).test(path);
}

function simpleDiff(before: string, after: string): string {
  const left = before.split("\n");
  const right = after.split("\n");
  const lines: string[] = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === right[index]) {
      lines.push(` ${left[index] ?? ""}`);
    } else {
      if (left[index] !== undefined) lines.push(`-${left[index]}`);
      if (right[index] !== undefined) lines.push(`+${right[index]}`);
    }
  }
  return lines.join("\n");
}
