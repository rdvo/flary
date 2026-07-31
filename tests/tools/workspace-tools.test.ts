import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryToolCatalog,
  registerWorkspaceTools,
  type WorkspaceToolTarget,
} from "../../src/harness/tools/index.js";
import {
  ProjectFileEntrySchema,
  ProjectFileReadResponseSchema,
} from "../../src/harness/contracts/filesystem.js";
import {
  GitBranchResponseSchema,
  GitCommitResponseSchema,
  GitDiffResponseSchema,
  GitMergeResponseSchema,
  GitStatusResponseSchema,
  WorkspaceBatchEditResponseSchema,
  WorkspaceDiffResponseSchema,
  WorkspaceGlobResponseSchema,
  WorkspaceGrepResponseSchema,
} from "../../src/harness/contracts/workspace-tools.js";

const file = ProjectFileEntrySchema.parse({
  path: "src/index.ts",
  size: 22,
  sha256: "a".repeat(64),
  mediaType: "text/typescript",
  storage: "inline",
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
});

function target(): WorkspaceToolTarget {
  return {
    async read() {
      return ProjectFileReadResponseSchema.parse({
        file,
        content: "export const ok = true;",
        encoding: "utf8",
      });
    },
    async write() {
      return { file };
    },
    async edit() {
      return { file, replacementCount: 1 };
    },
    async delete() {
      return { deleted: [file.path] };
    },
    async move() {
      return { file };
    },
    async list() {
      return { files: [file] };
    },
    async stat() {
      return file;
    },
    async glob() {
      return WorkspaceGlobResponseSchema.parse({ paths: [file.path] });
    },
    async grep() {
      return WorkspaceGrepResponseSchema.parse({
        files: [
          {
            path: file.path,
            matches: [
              {
                line: 1,
                column: 1,
                match: "export",
                lineText: "export const ok = true;",
              },
            ],
          },
        ],
      });
    },
    async diff() {
      return WorkspaceDiffResponseSchema.parse({
        path: file.path,
        diff: "@@ -1 +1 @@",
      });
    },
    async batchEdit() {
      return WorkspaceBatchEditResponseSchema.parse({
        results: [{ path: file.path, file, replacementCount: 1 }],
        totalReplacementCount: 1,
      });
    },
    git: {
      async status() {
        return GitStatusResponseSchema.parse({ entries: [] });
      },
      async diff() {
        return GitDiffResponseSchema.parse({ entries: [] });
      },
      async branch() {
        return GitBranchResponseSchema.parse({
          branches: ["main"],
          current: "main",
        });
      },
      async commit() {
        return GitCommitResponseSchema.parse({
          oid: "a".repeat(40),
          message: "test",
        });
      },
      async merge() {
        return GitMergeResponseSchema.parse({
          oid: "b".repeat(40),
          message: "merge",
        });
      },
    },
  };
}

test("workspace tools are lazy, typed, and approval-aware", async () => {
  const catalog = new InMemoryToolCatalog();
  const registered = registerWorkspaceTools(catalog, target());

  assert.equal(registered.descriptors.length, 16);
  const write = await catalog.load({ id: "workspace.file.write" });
  assert.equal(write?.capability.requiresApproval, true);
  const read = await catalog.loadHandle<
    { path: string; encoding: "utf8" },
    { content: string }
  >({ id: "workspace.file.read" });
  assert.ok(read);
  assert.equal(
    (await read.invoke({ path: file.path, encoding: "utf8" })).content,
    "export const ok = true;",
  );

  await assert.rejects(
    () => read.invoke({ path: "../secret", encoding: "utf8" }),
    /relative|canonical|segments/i,
  );
  assert.equal(
    (await catalog.load({ id: "workspace.git.status" }))?.capability
      .requiresApproval,
    false,
  );
  assert.equal(
    (await catalog.load({ id: "workspace.git.merge" }))?.capability
      .requiresApproval,
    true,
  );
});

test("workspace tool prefixes isolate multiple branches in one catalog", async () => {
  const catalog = new InMemoryToolCatalog();
  registerWorkspaceTools(catalog, target(), { prefix: "branch.main" });
  assert.ok(await catalog.load({ id: "branch.main.workspace.file.read" }));
  assert.equal(
    await catalog.load({ id: "workspace.file.read" }),
    undefined,
  );
});

test("workspace tools reject an invalid host target response", async () => {
  const catalog = new InMemoryToolCatalog();
  const invalid = target();
  invalid.read = async () => ({ content: "missing file metadata" }) as never;
  registerWorkspaceTools(catalog, invalid);
  const read = await catalog.loadHandle({ id: "workspace.file.read" });
  assert.ok(read);

  await assert.rejects(
    () => read.invoke({ path: "src/index.ts", encoding: "utf8" }),
    /file/i,
  );
});
