import {
  ArtifactCommitSchema,
  type ArtifactCommit,
} from "../storage/artifacts";
import {
  RecallDocumentSchema,
  type RecallDocumentInput,
  type RecallKind,
} from "../contracts/recall";
import type { RecallIndex } from "./index";

function kindForPath(path: string): RecallKind {
  if (path.startsWith("plans/")) return "plan";
  if (path.startsWith("decisions/")) return "decision";
  if (path.endsWith(".md")) return "plan";
  return "file";
}

function blocks(content: string, maxLines = 40): Array<{
  text: string;
  lineStart: number;
  lineEnd: number;
}> {
  const lines = content.split(/\r?\n/);
  const result: Array<{ text: string; lineStart: number; lineEnd: number }> = [];
  for (let start = 0; start < lines.length; start += maxLines) {
    const end = Math.min(lines.length, start + maxLines);
    const text = lines.slice(start, end).join("\n").trim();
    if (text) result.push({ text, lineStart: start + 1, lineEnd: end });
  }
  return result;
}

export class ArtifactRecallIndexer {
  constructor(private readonly index: RecallIndex) {}

  async indexCommit(input: ArtifactCommit): Promise<readonly string[]> {
    const commit = ArtifactCommitSchema.parse(input);
    const documents: RecallDocumentInput[] = [];
    for (const file of commit.files) {
      for (const block of blocks(file.content)) {
        const id =
          "artifact:" +
          commit.repository +
          ":" +
          commit.id +
          ":" +
          file.path +
          ":" +
          block.lineStart;
        documents.push(
          RecallDocumentSchema.parse({
            id,
            content: block.text,
            kind: kindForPath(file.path),
            scope: commit.scope,
            reference: {
              id,
              kind: kindForPath(file.path),
              organizationId: commit.scope.organizationId,
              appId: commit.scope.appId,
              projectId: commit.scope.projectId,
              sessionId: commit.scope.sessionId,
              repository: commit.repository,
              commit: commit.id,
              path: file.path,
              lineStart: block.lineStart,
              lineEnd: block.lineEnd,
              createdAt: commit.createdAt,
            },
            metadata: file.metadata,
            createdAt: commit.createdAt,
          }),
        );
      }
    }
    await this.index.upsert(documents);
    return documents.map((document) => document.id);
  }

  async removeCommit(ids: readonly string[]): Promise<void> {
    await this.index.delete(ids);
  }
}
