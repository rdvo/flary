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
  };
  assert.ok(wrangler.exports?.FlaryRuntime);
  assert.equal("migrations" in wrangler, false);
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
  assert.match(authoredHost, /getFunctionApp\(Object\.values\(functions\)\[0\]\)/);
  assert.match(authoredHost, /\.serve\(functions\)/);
  assert.ok(fs.existsSync(path.join(root, ".flue-vite/_entry.ts")));
  const generatedEntry = fs.readFileSync(
    path.join(root, ".flue-vite/_entry.ts"),
    "utf8",
  );
  assert.match(generatedEntry, /existing\.status !== 'active'/);
  assert.match(generatedEntry, /admitDetachedWorkflow\(\{/);
  assert.match(generatedEntry, /flaryInternalRequest/);
  const wrangler = JSON.parse(
    fs.readFileSync(path.join(root, ".flue-vite.wrangler.jsonc"), "utf8"),
  ) as {
    durable_objects?: { bindings?: Array<{ name: string; class_name: string }> };
    exports?: Record<string, unknown>;
    migrations?: unknown;
  };
  assert.ok(
    wrangler.durable_objects?.bindings?.some(
      (binding) => binding.name === "FLARY_RUN_SERVICE" && binding.class_name === "FlaryRuntime",
    ),
  );
  assert.ok(wrangler.exports?.FlaryRuntime);
  assert.equal("migrations" in wrangler, false);
});
