import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";

import { flary as createApp } from "../../src/harness/functions/index.ts";
import { flaryVite } from "../../src/vite.ts";

test("the Vite plugin emits populated Flue runtime entries", () => {
  const app = createApp({ model: "openai/gpt-5" });
  const support = app.fn({
    name: "support",
    input: z.object({ question: z.string() }),
    output: z.object({ answer: z.string() }),
    prompt: ({ question }) => question,
  });
  const native = app.fn({
    name: "native",
    input: z.object({ value: z.number() }),
    output: z.object({ value: z.number() }),
    run: ({ value }) => ({ value }),
  });
  const plugin = flaryVite({
    functions: { support, native },
    functionsEntry: "./src/index.ts",
    root: "/project",
  });
  const chunks: Array<{ id: string; fileName: string }> = [];
  plugin.buildStart?.call({
    emitFile(value) {
      chunks.push({ id: value.id, fileName: value.fileName });
    },
  });

  assert.deepEqual(
    chunks.map(({ fileName }) => fileName).sort(),
    ["flary/agents/support.js", "flary/workflows/native.js"],
  );
  const supportId = chunks.find(({ fileName }) =>
    fileName.includes("support")
  )!.id;
  assert.equal(plugin.resolveId?.(supportId), supportId);
  const source = plugin.load?.(supportId) ?? "";
  assert.match(source, /defineFlaryFunctionAgent/);
  assert.match(source, /flaryInternalRoute/);

  const assets = new Map<string, string>();
  plugin.generateBundle.call({
    emitFile(value) {
      assets.set(value.fileName, value.source);
    },
  });
  const manifest = assets.get("flary.manifest.json") ?? "";
  const parsed = JSON.parse(manifest) as {
    functions: Array<{ name: string; runtime: { kind: string } }>;
    cloudflare: { internalTokenBinding: string };
  };
  assert.equal(
    parsed.functions.find(({ name }) => name === "support")?.runtime.kind,
    "agent",
  );
  assert.equal(
    parsed.functions.find(({ name }) => name === "native")?.runtime.kind,
    "workflow",
  );
  assert.equal(
    parsed.cloudflare.internalTokenBinding,
    "FLARY_INTERNAL_TOKEN",
  );
  const wrangler = JSON.parse(assets.get("flary.wrangler.json") ?? "") as {
    exports?: Record<string, unknown>;
    migrations?: unknown;
    secrets?: { required?: string[] };
  };
  assert.ok(wrangler.exports?.FlaryRuntime);
  assert.ok(wrangler.exports?.FlaryWorkspace);
  assert.ok(
    (wrangler as any).durable_objects.bindings.some(
      (binding: { name: string }) => binding.name === "FLARY_WORKSPACE",
    ),
  );
  assert.ok(
    (wrangler as any).r2_buckets.some(
      (binding: { binding: string }) => binding.binding === "WORKSPACE_BLOBS",
    ),
  );
  assert.equal("migrations" in wrangler, false);
  assert.deepEqual(wrangler.secrets?.required, [
    "FLARY_INTERNAL_TOKEN",
    "FLARY_SESSION_ARCHIVE_KEY",
  ]);
});

test("the Vite plugin emits persistent app.agent entries", () => {
  const app = createApp({
    model: "openai/gpt-5",
    threadService: {} as never,
  });
  const coder = app.agent({
    name: "coder",
    description: "Persistent coding agent",
    instructions: "Work on the repository.",
  });
  const plugin = flaryVite({
    functions: { coder },
    functionsEntry: "./src/index.ts",
    root: "/project",
  });
  const chunks: Array<{ id: string; fileName: string }> = [];
  plugin.buildStart?.call({
    emitFile(value) {
      chunks.push({ id: value.id, fileName: value.fileName });
    },
  });
  assert.equal(chunks[0]?.fileName, "flary/agents/coder.js");
  assert.match(plugin.load?.(chunks[0]!.id) ?? "", /defineFlaryInteractiveAgent/);

  const assets = new Map<string, string>();
  plugin.generateBundle.call({
    emitFile(value) {
      assets.set(value.fileName, value.source);
    },
  });
  const manifest = JSON.parse(assets.get("flary.manifest.json") ?? "{}");
  assert.equal(manifest.agents[0].name, "coder");
  assert.equal(manifest.agents[0].revision, coder.revision);
  const wrangler = JSON.parse(assets.get("flary.wrangler.json") ?? "{}");
  assert.ok(wrangler.exports.FlaryThreadControl);
  assert.ok(wrangler.exports.FlaryWorkspace);
  assert.ok(
    wrangler.d1_databases.some(
      (binding: { binding: string }) =>
        binding.binding === "FLARY_THREAD_CATALOG",
    ),
  );
  assert.ok(
    wrangler.r2_buckets.some(
      (binding: { binding: string }) =>
        binding.binding === "FLARY_SESSION_ARCHIVE",
    ),
  );
  assert.ok(
    wrangler.r2_buckets.every(
      (binding: { bucket_name?: string }) => binding.bucket_name === undefined,
    ),
  );
  assert.ok(
    wrangler.queues.producers.some(
      (binding: { binding: string }) =>
        binding.binding === "FLARY_SESSION_PROJECTION_QUEUE",
    ),
  );
  assert.ok(
    wrangler.durable_objects.bindings.some(
      (binding: { name: string }) =>
        binding.name === "FLARY_THREAD_CONTROL",
    ),
  );
});

test("the Vite plugin generates optional Browser Run and Sandbox resources", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flary-vite-runtime-tools-"));
  try {
  const app = createApp({
    model: "openai/gpt-5",
    threadService: {} as never,
  });
  const tools = app.tools({
    browser: app.browser({ profile: "thread" }),
    shell: app.sandbox({ network: "restricted" }),
  });
  const coder = app.agent({
    name: "coder",
    instructions: "Work on the repository.",
    tools,
  });
  const plugin = flaryVite({
    functions: { coder },
    functionsEntry: "./src/index.ts",
    root,
  });
  const assets = new Map<string, string>();
  plugin.generateBundle.call({
    emitFile(value) {
      assets.set(value.fileName, value.source);
    },
  });
  const manifest = JSON.parse(assets.get("flary.manifest.json") ?? "{}");
  const wrangler = JSON.parse(assets.get("flary.wrangler.json") ?? "{}");
  assert.equal(manifest.cloudflare.browserRunBinding, "BROWSER");
  assert.equal(manifest.cloudflare.sandboxBinding, "SANDBOX");
  assert.deepEqual(wrangler.browser, { binding: "BROWSER" });
  assert.ok(
    wrangler.durable_objects.bindings.some(
      (binding: { name: string; class_name: string }) =>
        binding.name === "SANDBOX" && binding.class_name === "Sandbox",
    ),
  );
  assert.ok(
    wrangler.r2_buckets.some(
      (binding: { binding: string }) => binding.binding === "BACKUP_BUCKET",
    ),
  );
  assert.equal(wrangler.containers[0].class_name, "Sandbox");
  assert.match(
    fs.readFileSync(path.join(root, "Dockerfile"), "utf8"),
    /cloudflare\/sandbox:0\.12\.4/,
  );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the Vite plugin preserves legacy migrations without exports", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flary-vite-legacy-"));
  try {
    fs.writeFileSync(
      path.join(root, "wrangler.jsonc"),
      JSON.stringify({
        name: "legacy-worker",
        migrations: [{
          tag: "legacy-v1",
          new_sqlite_classes: ["ExistingRuntime"],
        }],
      }),
    );
    const app = createApp({ model: "openai/gpt-5" });
    const support = app.fn({
      name: "support",
      input: z.object({ question: z.string() }),
      output: z.object({ answer: z.string() }),
      prompt: ({ question }) => question,
    });
    const plugin = flaryVite({
      functions: { support },
      root,
    });
    const assets = new Map<string, string>();
    plugin.generateBundle.call({
      emitFile(value) {
        assets.set(value.fileName, value.source);
      },
    });
    const wrangler = JSON.parse(assets.get("flary.wrangler.json") ?? "") as {
      exports?: unknown;
      migrations?: Array<{ tag?: string; new_sqlite_classes?: string[] }>;
    };
    assert.equal("exports" in wrangler, false);
    assert.ok(wrangler.migrations?.some(({ tag }) => tag === "legacy-v1"));
    assert.ok(
      wrangler.migrations?.some(({ new_sqlite_classes }) =>
        new_sqlite_classes?.includes("FlaryRuntime")
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the Vite plugin rejects mixed Durable Object lifecycle systems", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flary-vite-mixed-"));
  try {
    fs.writeFileSync(
      path.join(root, "wrangler.jsonc"),
      JSON.stringify({
        exports: {},
        migrations: [],
      }),
    );
    const app = createApp({ model: "openai/gpt-5" });
    const support = app.fn({
      name: "support",
      input: z.object({ question: z.string() }),
      output: z.object({ answer: z.string() }),
      prompt: ({ question }) => question,
    });
    const plugin = flaryVite({ functions: { support }, root });
    assert.throws(
      () =>
        plugin.generateBundle.call({
          emitFile() {},
        }),
      /cannot contain both exports and migrations/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the Vite plugin removes Cloudflare's empty migrations artefact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flary-vite-output-"));
  try {
    const output = path.join(root, "dist", "worker");
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(
      path.join(output, "wrangler.json"),
      JSON.stringify({ exports: { Runtime: { type: "durable-object" } }, migrations: [] }),
    );
    const plugin = flaryVite({ root });
    plugin.closeBundle?.();
    const generated = JSON.parse(
      fs.readFileSync(path.join(output, "wrangler.json"), "utf8"),
    ) as { exports?: unknown; migrations?: unknown };
    assert.ok(generated.exports);
    assert.equal("migrations" in generated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the Vite plugin generates Flue Durable Object entry and bindings", (t) => {
  const root = path.resolve("tests/fixtures/function-runtime");
  const cli = path.resolve("apps/cloud/node_modules/.bin/flue");
  const agents = path.resolve("apps/cloud/node_modules/agents");
  if (!fs.existsSync(cli) || !fs.existsSync(agents)) {
    t.skip("the Cloudflare Flue build dependencies are not installed in the workspace");
    return;
  }
  const fixtureNodeModules = path.join(root, "node_modules");
  const fixtureAgents = path.join(fixtureNodeModules, "agents");
  fs.mkdirSync(fixtureNodeModules, { recursive: true });
  if (!fs.existsSync(fixtureAgents)) fs.symlinkSync(agents, fixtureAgents, "dir");
  t.after(() => fs.rmSync(fixtureNodeModules, { recursive: true, force: true }));
  const plugin = flaryVite({
    root,
    functionsEntry: "src/index.ts",
    flueCli: cli,
  });
  plugin.config?.({ root });

  const wrapper = fs.readFileSync(path.join(root, ".flue/agents/support.ts"), "utf8");
  assert.match(wrapper, /defineFlaryFunctionAgent/);
  assert.match(wrapper, /flaryInternalRoute\(flaryFunction\)/);
  const authoredHost = fs.readFileSync(path.join(root, ".flue/app.ts"), "utf8");
  assert.match(authoredHost, /getFunctionApp\(firstExport\)/);
  assert.match(authoredHost, /import authoredWorker, \{ functions \}/);
  assert.match(authoredHost, /const authoredResponse = await publicWorker\.fetch\(request, env, ctx\)/);
  assert.match(authoredHost, /authoredResponse\.status !== 404/);
  assert.match(authoredHost, /attachThreadService/);
  assert.match(authoredHost, /resolveModel: userApp\.options\.resolveModel/);
  assert.match(authoredHost, /\.serve\(functions\)/);
  assert.match(authoredHost, /flueRequest\(request, "\/api\/flue"\)/);
  assert.ok(fs.existsSync(path.join(root, ".flue-vite/_entry.ts")));
  const generatedEntry = fs.readFileSync(
    path.join(root, ".flue-vite/_entry.ts"),
    "utf8",
  );
  assert.match(generatedEntry, /existing\.status !== 'active'/);
  assert.match(generatedEntry, /admitDetachedWorkflow\(\{/);
  assert.match(generatedEntry, /flaryInternalRequest/);
  assert.match(generatedEntry, /cloudflareAgents\.compact\(this\)/);
  assert.match(generatedEntry, /cloudflareAgents\.rollback\(this/);
  assert.match(generatedEntry, /body\.excludeTarget === true/);
  const wrangler = JSON.parse(
    fs.readFileSync(path.join(root, ".flue-vite.wrangler.jsonc"), "utf8"),
  ) as {
    durable_objects?: { bindings?: Array<{ name: string; class_name: string }> };
    exports?: Record<string, unknown>;
    migrations?: unknown;
    d1_databases?: Array<{ binding: string }>;
    r2_buckets?: Array<{ binding: string }>;
    queues?: { producers?: Array<{ binding: string }> };
  };
  assert.ok(
    wrangler.durable_objects?.bindings?.some(
      (binding) => binding.name === "FLARY_RUN_SERVICE" && binding.class_name === "FlaryRuntime",
    ),
  );
  assert.ok(wrangler.exports?.FlaryRuntime);
  assert.ok(
    wrangler.d1_databases?.some(
      (binding) => binding.binding === "FLARY_THREAD_CATALOG",
    ),
  );
  assert.ok(
    wrangler.r2_buckets?.some(
      (binding) => binding.binding === "FLARY_SESSION_ARCHIVE",
    ),
  );
  assert.ok(
    wrangler.queues?.producers?.some(
      (binding) => binding.binding === "FLARY_SESSION_PROJECTION_QUEUE",
    ),
  );
  assert.equal("migrations" in wrangler, false);
});
