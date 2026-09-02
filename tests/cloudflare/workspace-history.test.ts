import assert from "node:assert/strict";
import test from "node:test";

import {
  createCloudflareWorkspaceConnection,
  createCloudflareWorkspaceHostControl,
} from "../../src/harness/cloudflare/workspace.ts";

test("generated workspace connections share one durable object and expose Git", async () => {
  const calls: Array<{ name: string; body: any }> = [];
  const namespace = {
    idFromName(name: string) {
      return name;
    },
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
  assert.deepEqual(parent.descriptors.find((tool) => tool.name === "read")?.inputSchema.required, [
    "path",
  ]);
  assert.deepEqual(parent.descriptors.find((tool) => tool.name === "stat")?.inputSchema.required, [
    "path",
  ]);
  assert.ok(
    parent.descriptors
      .find((tool) => tool.name === "glob")
      ?.inputSchema.required?.includes("pattern"),
  );
  assert.ok(
    parent.descriptors
      .find((tool) => tool.name === "grep")
      ?.inputSchema.required?.includes("query"),
  );
  assert.equal(
    parent.descriptors.find((tool) => tool.name === "grep")?.inputSchema.additionalProperties,
    false,
  );
  for (const name of ["write", "edit", "batchEdit", "move", "delete"]) {
    const descriptor = parent.descriptors.find((tool) => tool.name === name);
    assert.equal(descriptor?.operation, "write", `${name} is a built-in write tool`);
    assert.equal(descriptor?.requiresApproval, true);
  }
  assert.ok(parent.descriptors.some((tool) => tool.name === "git_status"));
  assert.ok(parent.descriptors.some((tool) => tool.name === "git_push"));
  assert.equal(parent.descriptors.find((tool) => tool.name === "git_status")?.operation, "read");
  assert.equal(parent.descriptors.find((tool) => tool.name === "git_push")?.requiresApproval, true);
  await parent.call("write", { path: "src/index.ts", content: "one" });
  await child.call("read", { path: "src/index.ts" });
  assert.equal(calls[0]?.name, calls[1]?.name);
  assert.equal(calls[0]?.body.scope.workspaceId, "workspace");
});

test("draft workspace writes stay writes without approval", async () => {
  const namespace = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return { fetch: async () => Response.json({ output: { ok: true } }) };
    },
  };
  const scope = {
    organizationId: "tenant",
    appId: "coder",
    projectId: "repo",
    workspaceId: "draft",
    branch: "main",
  };
  const draft = await createCloudflareWorkspaceConnection(namespace, scope, {
    approveWrites: false,
  });
  const write = draft.descriptors.find((tool) => tool.name === "write");
  assert.equal(write?.operation, "write");
  assert.equal(write?.requiresApproval, false);
});

test("model workspace connections hide trusted host metadata", async () => {
  const namespace = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        fetch: async () =>
          Response.json({
            output: {
              files: [{ path: ".tracked/context.json" }, { path: "index.html" }],
            },
          }),
      };
    },
  };
  const tools = await createCloudflareWorkspaceConnection(
    namespace,
    {
      organizationId: "tenant",
      appId: "coder",
      projectId: "repo",
      workspaceId: "draft",
      branch: "main",
    },
    { hiddenPaths: [".tracked"] },
  );
  assert.deepEqual(await tools.call("list", {}), {
    files: [{ path: "index.html" }],
  });
  await assert.rejects(tools.call("read", { path: ".tracked/context.json" }), /not available/);
});

test("workspace lifecycle controls stay on the trusted host boundary", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const namespace = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(request: Request) {
          const body = (await request.json()) as { input: unknown };
          calls.push({
            method: new URL(request.url).pathname.split("/").at(-1) ?? "",
            input: body.input,
          });
          return Response.json({ output: { seeded: true, files: [] } });
        },
      };
    },
  };
  const scope = {
    organizationId: "tenant",
    appId: "coder",
    projectId: "repo",
    workspaceId: "draft",
    branch: "main",
  };
  const host = await createCloudflareWorkspaceHostControl(namespace, scope);
  await host.seed({
    requestId: "seed_1",
    files: [{ path: "README.md", content: "hello" }],
  });
  await host.read({ path: "README.md", encoding: "base64" });
  await host.checkpoint({
    requestId: "checkpoint_1",
    id: "baseline_1",
    metadata: { kind: "test" },
  });
  assert.equal(calls[0]?.method, "__seed");
  assert.deepEqual(calls[1], {
    method: "read",
    input: { path: "README.md", encoding: "base64" },
  });
  assert.equal(calls[2]?.method, "__checkpoint");
  assert.deepEqual(calls[2]?.input, {
    id: "baseline_1",
    sessionId: "draft",
    metadata: { kind: "test", hostRequestId: "checkpoint_1" },
  });
  const tools = await createCloudflareWorkspaceConnection(namespace, scope);
  assert.equal(
    tools.descriptors.some((tool) => tool.name.startsWith("__")),
    false,
  );
});
