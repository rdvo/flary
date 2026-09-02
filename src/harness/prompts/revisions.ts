import { PromptRevisionSchema, type PromptRevision } from "../contracts/prompt-revisions.js";

export type CreatePromptRevisionInput = Omit<PromptRevision, "id" | "revision" | "createdAt"> & {
  id?: string;
  revision?: number;
  createdAt?: string;
};

export interface PromptRevisionStore {
  create(input: CreatePromptRevisionInput): Promise<PromptRevision>;
  get(id: string): Promise<PromptRevision | undefined>;
  list(promptId: string): Promise<readonly PromptRevision[]>;
  current(promptId: string): Promise<PromptRevision | undefined>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Append-only prompt revision store for local products and tests.
 * Cloud deployments use the D1 prompt_revision table with the same rules.
 */
export class InMemoryPromptRevisionStore implements PromptRevisionStore {
  private readonly revisions: PromptRevision[] = [];

  async create(input: CreatePromptRevisionInput): Promise<PromptRevision> {
    const duplicate = this.revisions.find(
      (revision) =>
        revision.promptId === input.promptId && revision.sourceHash === input.sourceHash,
    );
    if (duplicate) return clone(duplicate);

    const latest = this.revisions
      .filter((revision) => revision.promptId === input.promptId)
      .sort((left, right) => right.revision - left.revision)[0];
    const revision = PromptRevisionSchema.parse({
      ...input,
      id: input.id ?? `prompt_revision_${crypto.randomUUID()}`,
      revision: input.revision ?? (latest?.revision ?? 0) + 1,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
    if (
      this.revisions.some(
        (existing) =>
          existing.promptId === revision.promptId && existing.revision === revision.revision,
      )
    ) {
      throw new Error(`Prompt revision ${revision.promptId}#${revision.revision} already exists`);
    }
    this.revisions.push(clone(revision));
    return clone(revision);
  }

  async get(id: string): Promise<PromptRevision | undefined> {
    const revision = this.revisions.find((candidate) => candidate.id === id);
    return revision ? clone(revision) : undefined;
  }

  async list(promptId: string): Promise<readonly PromptRevision[]> {
    return this.revisions
      .filter((revision) => revision.promptId === promptId)
      .sort((left, right) => right.revision - left.revision)
      .map(clone);
  }

  async current(promptId: string): Promise<PromptRevision | undefined> {
    return (await this.list(promptId))[0];
  }
}
