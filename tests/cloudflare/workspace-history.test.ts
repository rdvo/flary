import assert from "node:assert/strict";
import test from "node:test";

import {
  createCloudflareWorkspaceConnection,
} from "../../src/harness/cloudflare/workspace.ts";

test("generated workspace connections share one durable object and expose Git", async () => {
  const calls: Array<{ name: string; body: any }> = [];
  const namespace = {
    idFromName(name: string) { return name; },
    get(id: { toString(): string } | string) {
      return {
        async fetch(request: Request) {
          calls.push({
            name: String(id),
            body: await request.json(),
          });
          return Response.json({ output: { ok: true } });
        },
      };
    },
  };
  const scope = {
    organizationId: "tenant",
    appId: "coder",
    projectId: "repo",
    workspaceId: "workspace",
    branch: "main",
  };
  const parent = await createCloudflareWorkspaceConnection(namespace, scope);
  const child = await createCloudflareWorkspaceConnection(namespace, scope);

  for (const name of ["list", "stat", "glob", "grep", "read", "diff"]) {
    const descriptor = parent.descriptors.find((tool) => tool.name === name);
    assert.equal(descriptor?.operation, "read", `${name} is a built-in read tool`);
    assert.equal(descriptor?.requiresApproval, false);
  }
  for (const name of ["write", "edit", "batchEdit", "move", "delete"]) {
    const descriptor = parent.descriptors.find((tool) => tool.name === name);
    assert.equal(descriptor?.operation, "write", `${name} is a built-in write tool`);
    assert.equal(descriptor?.requiresApproval, true);
  }
  assert.ok(parent.descriptors.some((tool) => tool.name === "git_status"));
  assert.ok(parent.descriptors.some((tool) => tool.name === "git_push"));
  assert.equal(
    parent.descriptors.find((tool) => tool.name === "git_status")?.operation,
    "read",
  );
  assert.equal(
    parent.descriptors.find((tool) => tool.name === "git_push")?.requiresApproval,
    true,
  );
  await parent.call("write", { path: "src/index.ts", content: "one" });
  await child.call("read", { path: "src/index.ts" });
  assert.equal(calls[0]?.name, calls[1]?.name);
  assert.equal(calls[0]?.body.scope.workspaceId, "workspace");
});
