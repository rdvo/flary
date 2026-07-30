import { getFunctionState } from "./harness/functions/app.js";
import type { FlaryToolRegistry } from "./harness/functions/types.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export interface FlaryVitePluginOptions {
  /**
   * Optional in-memory registry for tests and non-Cloudflare builds.
   * Cloudflare Vite configs should use `functionsEntry` so Node does not
   * evaluate Worker-only modules while it loads the config.
   */
  readonly functions?: Readonly<Record<string, unknown>>;
  /** Module that exports the same `functions` registry. */
  readonly functionsEntry?: string;
  readonly root?: string;
  readonly tools?: readonly FlaryToolRegistry[];
  readonly manifestFileName?: string;
  /** Generated Wrangler configuration name. */
  readonly wranglerFileName?: string;
  /** Set false to keep the manifest-only integration for non-Cloudflare builds. */
  readonly generateRuntime?: boolean;
  /** Override the Flue CLI executable used for runtime generation. */
  readonly flueCli?: string;
  /** Optional authored Runtime Durable Object implementation. */
  readonly runtimeEntry?: string;
}

export interface FlaryManifest {
  readonly version: 1;
  readonly functions: readonly {
    readonly name: string;
    readonly mode: string;
    readonly description?: string;
    readonly inputSchema?: Record<string, unknown>;
    readonly outputSchema?: Record<string, unknown>;
    readonly tools?: readonly string[];
    readonly runtime?: {
      readonly kind: "agent" | "workflow";
      readonly module: string;
    };
  }[];
  readonly tools: readonly string[];
  readonly cloudflare: {
    readonly dynamicWorkerBinding: "LOADER";
    readonly internalTokenBinding: "FLARY_INTERNAL_TOKEN";
    readonly durableStorage: "sqlite";
    readonly runServiceBinding: "FLARY_RUN_SERVICE";
    readonly runServiceClass: "FlaryRuntime";
    readonly flueRegistryBinding: "FLUE_REGISTRY";
    readonly flueRuntimeVersion: "1.0.0-beta.9";
    readonly migrations: readonly {
      readonly tag: string;
      readonly newSqliteClasses: readonly string[];
    }[];
  };
}

interface FlaryVitePlugin {
  readonly name: string;
  readonly enforce?: "pre" | "post";
  config?(config: { readonly root?: string }): void;
  buildStart?(
    this: {
      emitFile(input: {
        type: "chunk";
        id: string;
        fileName: string;
      }): void;
    },
  ): void;
  resolveId?(id: string): string | undefined;
  load?(id: string): string | undefined;
  generateBundle(
    this: {
      emitFile(input: {
        type: "asset";
        fileName: string;
        source: string;
      }): void;
    },
  ): void;
}

const VIRTUAL_PREFIX = "\0flary:function:";

/**
 * Small Vite integration for function manifests.
 *
 * The generated manifest is immutable build output. Cloudflare's Worker
 * loader and Durable Object bindings can consume it in a host-specific
 * plugin without changing the Flary function authoring API.
 */
export function flary(options: FlaryVitePluginOptions = {}): {
  name: string;
  enforce: "pre";
  config: (config: { readonly root?: string }) => void;
  buildStart: FlaryVitePlugin["buildStart"];
  resolveId: FlaryVitePlugin["resolveId"];
  load: FlaryVitePlugin["load"];
  generateBundle: FlaryVitePlugin["generateBundle"];
} {
  let resolvedRoot = path.resolve(options.root ?? process.cwd());
  const functionEntries = () =>
    (options.functions
      ? Object.entries(options.functions).map(([name, value]) => ({
          name,
          value,
          mode: getFunctionState(value)?.mode,
        }))
      : discoverFunctionEntries(options, resolvedRoot)
    ).map(({ name, value, mode }) => {
      const state = getFunctionState(value);
      return {
        name,
        value,
        state,
        mode: state?.mode ?? mode,
        runtimeFile:
          `flary/${(state?.mode ?? mode) === "run" ? "workflows" : "agents"}/${name}.js`,
      };
    });
  return {
    name: "flary-functions",
    enforce: "pre",
    config(config) {
      resolvedRoot = path.resolve(config.root ?? options.root ?? process.cwd());
      if (options.generateRuntime === false || !options.functionsEntry) return;
      const entry = path.resolve(resolvedRoot, options.functionsEntry);
      if (!fs.existsSync(entry)) return;
      generateFlueRuntime({
        root: resolvedRoot,
        entry,
        functions: functionEntries(),
        cli: options.flueCli,
        runtimeEntry: options.runtimeEntry,
      });
    },
    buildStart() {
      for (const entry of functionEntries()) {
        if (!entry.state && !entry.mode) {
          throw new Error(`Flary function '${entry.name}' is not registered`);
        }
        this.emitFile({
          type: "chunk",
          id: `${VIRTUAL_PREFIX}${entry.name}`,
          fileName: entry.runtimeFile,
        });
      }
    },
    resolveId(id) {
      return id.startsWith(VIRTUAL_PREFIX) ? id : undefined;
    },
    load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return undefined;
      const name = id.slice(VIRTUAL_PREFIX.length);
      const entry = functionEntries().find((item) => item.name === name);
      if (!entry || (!entry.state && !entry.mode)) {
        throw new Error(`Flary function '${name}' is not registered`);
      }
      const source = path.resolve(
        resolvedRoot,
        options.functionsEntry ?? "src/index.ts",
      );
      const compiler = entry.mode === "run"
        ? "defineFlaryFunctionWorkflow"
        : "defineFlaryFunctionAgent";
      return [
        `import { functions } from ${JSON.stringify(source)};`,
        `import { ${compiler}, flaryInternalRoute, flaryInternalRequest as handleFlaryInternalRequest } from "flary/functions";`,
        `const flaryFunction = functions[${JSON.stringify(name)}];`,
        `export default ${compiler}(flaryFunction);`,
        "export const route = flaryInternalRoute(flaryFunction);",
        "export const runs = flaryInternalRoute(flaryFunction);",
        "export const flaryInternalRequest = (request, env) => handleFlaryInternalRequest(flaryFunction, request, env);",
      ].join("\n");
    },
    generateBundle() {
      const functions = functionEntries().map(({ name, state, mode, runtimeFile }) => {
        const definition = state?.definition;
        return {
          name,
          mode: state?.mode ?? mode ?? "unknown",
          ...(definition?.description ? { description: definition.description } : {}),
          ...(definition ? { inputSchema: toSchema(definition.input), outputSchema: toSchema(definition.output) } : {}),
          ...(definition?.tools ? { tools: definition.tools.names } : {}),
          ...(state || mode
            ? {
                runtime: {
                  kind: (state?.mode ?? mode) === "run"
                    ? "workflow" as const
                    : "agent" as const,
                  module: runtimeFile,
                },
              }
            : {}),
        };
      });
      const tools = [...new Set((options.tools ?? []).flatMap((registry) => registry.names))];
      const runtimeClasses = functions.map(({ name, mode }) =>
        mode === "run" ? `Flue${pascalCaseName(name)}Workflow` : `Flue${pascalCaseName(name)}Agent`,
      );
      const migrationClasses = [
        "FlaryRuntime",
        "FlueRegistry",
        ...runtimeClasses,
      ];
      const manifest: FlaryManifest = {
        version: 1,
        functions,
        tools,
        cloudflare: {
          dynamicWorkerBinding: "LOADER",
          internalTokenBinding: "FLARY_INTERNAL_TOKEN",
          durableStorage: "sqlite",
          runServiceBinding: "FLARY_RUN_SERVICE",
          runServiceClass: "FlaryRuntime",
          flueRegistryBinding: "FLUE_REGISTRY",
          flueRuntimeVersion: "1.0.0-beta.9",
          migrations: [{
            tag: "flary-v1",
            newSqliteClasses: migrationClasses,
          }],
        },
      };
      const wrangler = mergeWranglerConfig(
        readWranglerConfig(options.root ?? process.cwd()),
        runtimeClasses,
        migrationClasses,
      );
      this.emitFile({
        type: "asset",
        fileName: options.wranglerFileName ?? "flary.wrangler.json",
        source: JSON.stringify(wrangler, null, 2),
      });
      this.emitFile({
        type: "asset",
        fileName: options.manifestFileName ?? "flary.manifest.json",
        source: JSON.stringify(manifest, null, 2),
      });
    },
  };
}

function readWranglerConfig(root: string): Record<string, any> {
  const candidates = ["wrangler.jsonc", "wrangler.json"];
  for (const candidate of candidates) {
    const file = path.resolve(root, candidate);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = YAML.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Keep a minimal generated config when the authored file is invalid.
      // Wrangler will report the source configuration error separately.
    }
  }
  return { "$schema": "./node_modules/wrangler/config-schema.json" };
}

type WranglerDurableObjectLifecycle = "exports" | "migrations";

function durableObjectLifecycle(
  base: Record<string, any>,
): WranglerDurableObjectLifecycle {
  const hasExports = Object.prototype.hasOwnProperty.call(base, "exports");
  const hasMigrations = Object.prototype.hasOwnProperty.call(base, "migrations");
  if (hasExports && hasMigrations) {
    throw new Error(
      "Wrangler Durable Object configuration cannot contain both exports and migrations. Use exports for a new Worker, or keep migrations for an existing legacy Worker.",
    );
  }
  return hasMigrations ? "migrations" : "exports";
}

function mergeWranglerConfig(
  base: Record<string, any>,
  runtimeClasses: readonly string[],
  migrationClasses: readonly string[],
  lifecycle = durableObjectLifecycle(base),
): Record<string, any> {
  const currentBindings = isRecord(base.durable_objects) &&
      Array.isArray(base.durable_objects.bindings)
    ? base.durable_objects.bindings
    : [];
  const generatedBindings = [
    { name: "FLARY_RUN_SERVICE", class_name: "FlaryRuntime" },
    ...runtimeClasses.map((name) => ({
      name: flueBindingName(name),
      class_name: name,
    })),
    { name: "FLUE_REGISTRY", class_name: "FlueRegistry" },
  ];
  const byName = new Map<string, Record<string, unknown>>();
  for (const binding of currentBindings) {
    if (isRecord(binding) && typeof binding.name === "string") {
      byName.set(binding.name, binding);
    }
  }
  for (const binding of generatedBindings) byName.set(binding.name, binding);
  const migrations = Array.isArray(base.migrations)
    ? base.migrations.filter(isRecord).map((value) => ({ ...value }))
    : [];
  const latest = migrations.at(-1);
  const existingClasses = latest && Array.isArray(latest.new_sqlite_classes)
    ? latest.new_sqlite_classes.filter((value): value is string => typeof value === "string")
    : [];
  const generatedMigration = {
    tag: "flary-v1",
    new_sqlite_classes: [...new Set([...existingClasses, ...migrationClasses])],
  };
  const existingMigration = migrations.find((value) => value.tag === "flary-v1");
  if (existingMigration) {
    existingMigration.new_sqlite_classes = generatedMigration.new_sqlite_classes;
  } else {
    migrations.push(generatedMigration);
  }
  const currentExports = isRecord(base.exports) ? { ...base.exports } : {};
  for (const name of ["FlaryRuntime", "FlueRegistry", ...runtimeClasses]) {
    if (!isRecord(currentExports[name])) {
      currentExports[name] = { type: "durable-object", storage: "sqlite" };
    }
  }
  const workerLoaders = Array.isArray(base.worker_loaders)
    ? base.worker_loaders.filter(isRecord).map((value) => ({ ...value }))
    : [];
  if (!workerLoaders.some((value) => value.binding === "LOADER")) {
    workerLoaders.push({ binding: "LOADER" });
  }
  const {
    exports: _authoredExports,
    migrations: _authoredMigrations,
    ...baseWithoutLifecycle
  } = base;
  return {
    ...baseWithoutLifecycle,
    durable_objects: {
      ...(isRecord(base.durable_objects) ? base.durable_objects : {}),
      bindings: [...byName.values()],
    },
    ...(lifecycle === "migrations"
      ? { migrations }
      : { exports: currentExports }),
    worker_loaders: workerLoaders,
  };
}

function flueBindingName(className: string): string {
  const agent = /^Flue(.+)Agent$/.exec(className);
  if (agent) return `FLUE_${screamingSnake(agent[1]!)}_AGENT`;
  const workflow = /^Flue(.+)Workflow$/.exec(className);
  if (workflow) return `FLUE_${screamingSnake(workflow[1]!)}_WORKFLOW`;
  return className.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

function screamingSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

interface GeneratedFunctionEntry {
  readonly name: string;
  readonly mode?: "prompt" | "run";
}

/**
 * Generate the Flue Cloudflare entry that owns the agent and workflow
 * Durable Objects. The generated files live under `.flue`; they are marked
 * and replaced on the next build, while authored `.flue` files are rejected
 * instead of being overwritten.
 */
function generateFlueRuntime(input: {
  readonly root: string;
  readonly entry: string;
  readonly functions: readonly GeneratedFunctionEntry[];
  readonly cli?: string;
  readonly runtimeEntry?: string;
}): void {
  if (input.functions.length === 0) {
    throw new Error(
      "Flary Vite could not find any functions. Export `functions` from the module passed as `functionsEntry`.",
    );
  }
  for (const entry of input.functions) {
    if (!entry.mode) {
      throw new Error(
        `Flary Vite cannot determine the mode for function '${entry.name}'. Give it a prompt or run implementation.`,
      );
    }
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(entry.name)) {
      throw new Error(
        `Flary function '${entry.name}' must use a lower-kebab-case name for Cloudflare Durable Object bindings.`,
      );
    }
  }

  const authoredWrangler = readWranglerConfig(input.root);
  const lifecycle = durableObjectLifecycle(authoredWrangler);
  const generatedRoot = path.join(input.root, ".flue");
  prepareGeneratedDirectory(generatedRoot);
  const agentsRoot = path.join(generatedRoot, "agents");
  const workflowsRoot = path.join(generatedRoot, "workflows");
  fs.mkdirSync(agentsRoot, { recursive: true });
  fs.mkdirSync(workflowsRoot, { recursive: true });
  clearGeneratedModules(agentsRoot);
  clearGeneratedModules(workflowsRoot);

  const importPath = relativeImport(agentsRoot, input.entry);
  const generatedImport = JSON.stringify(importPath);
  for (const entry of input.functions) {
    const directory = entry.mode === "run" ? workflowsRoot : agentsRoot;
    const compiler = entry.mode === "run"
      ? "defineFlaryFunctionWorkflow"
      : "defineFlaryFunctionAgent";
    const source = [
      GENERATED_MARKER,
      `import { functions } from ${generatedImport};`,
      `import { ${compiler}, flaryInternalRoute, flaryInternalRequest as handleFlaryInternalRequest } from "flary/functions";`,
      `const flaryFunction = functions[${JSON.stringify(entry.name)}];`,
      `export default ${compiler}(flaryFunction);`,
      "export const route = flaryInternalRoute(flaryFunction);",
      ...(entry.mode === "run" ? ["export const runs = flaryInternalRoute(flaryFunction);"] : []),
      "export const flaryInternalRequest = (request, env) => handleFlaryInternalRequest(flaryFunction, request, env);",
      "",
    ].join("\n");
    writeGeneratedFile(path.join(directory, `${entry.name}.ts`), source);
  }
  writeGeneratedFile(
    path.join(generatedRoot, "app.ts"),
    generatedAppSource(input),
  );
  writeGeneratedFile(
    path.join(generatedRoot, "cloudflare.ts"),
    generatedCloudflareSource(input),
  );

  const cli = input.cli ?? "flue";
  try {
    execFileSync(cli, [
      "build",
      "--target",
      "cloudflare",
      "--root",
      input.root,
      "--output",
      path.join(input.root, "dist", "flue-runtime"),
    ], {
      cwd: input.root,
      stdio: "pipe",
      env: process.env,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Flary Vite could not run the pinned Flue CLI (${cli}). Install @flue/cli@1.0.0-beta.9 or set flueCli. ${detail}`,
    );
  }

  patchGeneratedWorkflowRecovery(input.root);
  patchGeneratedFlueInternalRoutes(input.root, input.functions);

  const generatedWrangler = path.join(input.root, ".flue-vite.wrangler.jsonc");
  if (fs.existsSync(generatedWrangler)) {
    const generatedBase = readJsoncFile(generatedWrangler);
    const base = lifecycle === "migrations"
      ? {
          ...generatedBase,
          migrations: Array.isArray(authoredWrangler.migrations)
            ? authoredWrangler.migrations
            : [],
        }
      : {
          ...generatedBase,
          exports: isRecord(authoredWrangler.exports)
            ? authoredWrangler.exports
            : {},
        };
    const runtimeClasses = input.functions.map(({ name, mode }) =>
      mode === "run" ? `Flue${pascalCaseName(name)}Workflow` : `Flue${pascalCaseName(name)}Agent`,
    );
    const migrationClasses = ["FlaryRuntime", "FlueRegistry", ...runtimeClasses];
    fs.writeFileSync(
      generatedWrangler,
      JSON.stringify(
        mergeWranglerConfig(base, runtimeClasses, migrationClasses, lifecycle),
        null,
        2,
      ),
      "utf8",
    );
  }
}

/**
 * Flue beta.9 marks an interrupted workflow fiber as failed. Flary native
 * functions use replay-safe named steps, so the same workflow input can be
 * admitted again after an eviction. The Flue run store and event stream are
 * idempotent; completed Flary steps then replay from SQLite.
 */
function patchGeneratedWorkflowRecovery(root: string): void {
  const entry = path.join(root, ".flue-vite", "_entry.ts");
  if (!fs.existsSync(entry)) return;
  const source = fs.readFileSync(entry, "utf8");
  const marker = "async function handleFlueWorkflowFiberRecovered(ctx, doInstance, workflowName) {";
  const start = source.indexOf(marker);
  if (start < 0) return;
  const endMarker = "\n}\n\nasync function dispatchWorkflow";
  const end = source.indexOf(endMarker, start);
  if (end < 0) return;
  if (source.slice(start, end).includes("admitDetachedWorkflow({")) return;
  const replacement = [
    marker,
    "  if (!ctx.name || ctx.name !== 'flue:workflow:' + doInstance.name) return;",
    "  const interruptedRunId = doInstance.name;",
    "  const runStore = createRunStoreForRequest(doInstance);",
    "  const existing = await runStore.getRun(interruptedRunId);",
    "  if (!existing || existing.status !== 'active') {",
    "    await failRecoveredRun({",
    "      workflowName,",
    "      runId: interruptedRunId,",
    "      request: new Request('https://flue.invalid/workflows/' + encodeURIComponent(workflowName), { method: 'POST' }),",
    "      error: new Error('Flue workflow recovery has no active run record.'),",
    "      runStore,",
    "      eventStreamStore: createEventStreamStoreForInstance(doInstance),",
    "      createContext: (options) => createWorkflowContextForRequest(options, doInstance),",
    "    });",
    "    return;",
    "  }",
    "  const workflow = workflows.find((record) => record.name === workflowName)?.definition;",
    "  if (!workflow) throw new Error('[flue] Cannot recover unknown workflow ' + workflowName);",
    "  await admitDetachedWorkflow({",
    "    workflowName,",
    "    runId: interruptedRunId,",
    "    workflow,",
    "    input: existing.input,",
    "    request: new Request('https://flue.invalid/workflows/' + encodeURIComponent(workflowName), { method: 'POST' }),",
    "    runStore,",
    "    eventStreamStore: createEventStreamStoreForInstance(doInstance),",
    "    createContext: (options) => createWorkflowContextForRequest(options, doInstance),",
    "    startWorkflowAdmission: (runId, run) => {",
    "      assertAgentsDurabilityApi(doInstance, 'runFiber');",
    "      const admission = Promise.withResolvers();",
    "      const completion = doInstance.runFiber('flue:workflow:' + runId, () => {",
    "        admission.resolve();",
    "        return runWithInstanceContext(doInstance, workflowRuntimeIdentity(workflowName), run);",
    "      });",
    "      completion.catch(admission.reject);",
    "      return { admitted: admission.promise, completion };",
    "    },",
    "  });",
    "}",
  ].join("\n");
  fs.writeFileSync(
    entry,
    source.slice(0, start) + replacement + source.slice(end + 2),
    "utf8",
  );
}

/** Route Runtime Durable Object approval RPCs into generated Flue classes. */
function patchGeneratedFlueInternalRoutes(
  root: string,
  functions: readonly GeneratedFunctionEntry[],
): void {
  const entry = path.join(root, ".flue-vite", "_entry.ts");
  if (!fs.existsSync(entry)) return;
  let source = fs.readFileSync(entry, "utf8");
  for (const functionEntry of functions) {
    const kind = functionEntry.mode === "run" ? "workflow" : "agent";
    const variable = new RegExp(
      `import \\* as ([A-Za-z0-9_$]+) from ["'][^"']+/${kind}s/${escapeRegExp(functionEntry.name)}\\.ts["'];`,
    ).exec(source)?.[1];
    if (!variable) continue;
    const className = functionEntry.mode === "run"
      ? `Flue${pascalCaseName(functionEntry.name)}Workflow`
      : `Flue${pascalCaseName(functionEntry.name)}Agent`;
    const old = kind === "agent"
      ? "  onRequest(request) {\n    return cloudflareAgents.onRequest(this, request);\n  }"
      : `  async onRequest(request) {\n    return dispatchWorkflow(request, this, ${JSON.stringify(functionEntry.name)});\n  }`;
    if (!source.includes(`const ${className} =`) || !source.includes(old)) continue;
    const replacement = kind === "agent"
      ? `  async onRequest(request) {\n    const internal = await ${variable}.flaryInternalRequest?.(request, this.env);\n    if (internal) return internal;\n    return cloudflareAgents.onRequest(this, request);\n  }`
      : `  async onRequest(request) {\n    if (new URL(request.url).searchParams.get('flary') === 'wake' && request.method === 'GET') {\n      await cloudflareAgents.wakeSubmissions(this);\n      return Response.json({ ok: true });\n    }\n    const internal = await ${variable}.flaryInternalRequest?.(request, this.env);\n    if (internal) return internal;\n    return dispatchWorkflow(request, this, ${JSON.stringify(functionEntry.name)});\n  }`;
    source = source.replace(old, replacement);
  }
  fs.writeFileSync(entry, source, "utf8");
}

const GENERATED_MARKER = "// @generated by flary/vite; do not edit";

function prepareGeneratedDirectory(directory: string): void {
  if (fs.existsSync(directory)) {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    const authored = entries.filter((entry) =>
      entry.name !== "agents" && entry.name !== "workflows" && entry.name !== "app.ts" && entry.name !== "cloudflare.ts",
    );
    if (authored.length > 0) {
      throw new Error(
        `Flary Vite will not overwrite authored files in ${directory}. Move existing Flue sources or set generateRuntime: false.`,
      );
    }
  } else {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function clearGeneratedModules(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const file = path.join(directory, entry.name);
    const source = fs.readFileSync(file, "utf8");
    if (source.startsWith(GENERATED_MARKER)) fs.rmSync(file);
  }
}

function writeGeneratedFile(file: string, source: string): void {
  if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").startsWith(GENERATED_MARKER)) {
    throw new Error(`Flary Vite will not overwrite authored file ${file}.`);
  }
  fs.writeFileSync(file, source, "utf8");
}

function generatedCloudflareSource(input: {
  readonly root: string;
  readonly runtimeEntry?: string;
}): string {
  if (input.runtimeEntry) {
    return [
      GENERATED_MARKER,
      `export * from ${JSON.stringify(relativeImport(path.join(input.root, ".flue"), path.resolve(input.root, input.runtimeEntry)))};`,
      "",
    ].join("\n");
  }
  return [
    GENERATED_MARKER,
    'import { DurableObject } from "cloudflare:workers";',
    'import { createCloudflareFlueGateway, createFlaryCodemodeApprovalHooks, handleFlaryDurableRunObjectRequest } from "flary/cloudflare";',
    "",
    "export class FlaryRuntime extends DurableObject {",
    "  async fetch(request: Request): Promise<Response> {",
    "    const env = this.env as Record<string, unknown>;",
    "    return handleFlaryDurableRunObjectRequest({",
    "      state: { storage: this.ctx.storage, waitUntil: (work) => this.ctx.waitUntil(work) },",
    "      env,",
    "      request,",
    "      options: {",
    "        createGateway: (bindings) => createCloudflareFlueGateway(bindings, { token: typeof bindings.FLARY_INTERNAL_TOKEN === \"string\" ? bindings.FLARY_INTERNAL_TOKEN : undefined }),",
    "        createApprovalHooks: (bindings, repository) => createFlaryCodemodeApprovalHooks(bindings, { repository })!(bindings, repository),",
    "      },",
    "    });",
    "  }",
    "}",
    "",
  ].join("\n");
}

function generatedAppSource(input: {
  readonly root: string;
  readonly entry: string;
}): string {
  return [
    GENERATED_MARKER,
    `import { functions } from ${JSON.stringify(relativeImport(path.join(input.root, ".flue"), input.entry))};`,
    'import { getFunctionApp } from "flary/functions";',
    'import { createFlaryDurableRunService } from "flary/cloudflare";',
    "const userApp = getFunctionApp(Object.values(functions)[0]);",
    'if (!userApp) throw new Error("Flary Vite needs functions created by one flary() application");',
    "",
    "export default userApp.attachRunService(({ bindings }) => {",
    "  const namespace = bindings.FLARY_RUN_SERVICE;",
    "  if (!namespace) throw new Error(\"FLARY_RUN_SERVICE is not configured\");",
    "  return createFlaryDurableRunService({ namespace: namespace as never });",
    "}).serve(functions);",
    "",
  ].join("\n");
}

function relativeImport(from: string, to: string): string {
  const relative = path.relative(from, to).replace(/\\/g, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function readJsoncFile(file: string): Record<string, any> {
  try {
    const parsed = YAML.parse(fs.readFileSync(file, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function pascalCaseName(name: string): string {
  return name
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function discoverFunctionEntries(
  options: FlaryVitePluginOptions,
  root = options.root ?? process.cwd(),
): Array<{
  name: string;
  value: undefined;
  mode?: "prompt" | "run";
}> {
  const entry = path.resolve(
    root,
    options.functionsEntry ?? "src/index.ts",
  );
  let source: string;
  try {
    source = fs.readFileSync(entry, "utf8");
  } catch {
    return [];
  }
  const registry = /export\s+const\s+functions\s*=\s*\{([\s\S]*?)\}/m.exec(
    source,
  )?.[1];
  if (!registry) return [];
  const imports = new Map<string, string>();
  for (const match of source.matchAll(
    /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g,
  )) {
    for (const item of match[1]!.split(",")) {
      const [imported, local = imported] = item.trim().split(/\s+as\s+/);
      if (local) imports.set(local, match[2]!);
    }
  }
  return registry
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [key, local = key] = item.split(":").map((value) => value.trim());
      return {
        name: key!,
        value: undefined,
        mode:
          detectFunctionMode(entry, imports.get(local!)) ??
          detectInlineFunctionMode(source, local!),
      };
    });
}

function detectFunctionMode(
  entry: string,
  importPath: string | undefined,
): "prompt" | "run" | undefined {
  if (!importPath?.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(entry), importPath);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) return undefined;
  const source = fs.readFileSync(file, "utf8");
  if (/\bprompt\s*:/.test(source)) return "prompt";
  if (/\brun\s*:/.test(source)) return "run";
  return undefined;
}

function detectInlineFunctionMode(
  source: string,
  local: string,
): "prompt" | "run" | undefined {
  const declaration = new RegExp(
    `(?:const|let|var)\\s+${escapeRegExp(local)}\\s*=([\\s\\S]{0,16384})`,
  ).exec(source)?.[1];
  if (!declaration) return undefined;
  if (/\bprompt\s*:/.test(declaration)) return "prompt";
  if (/\brun\s*:/.test(declaration)) return "run";
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const flaryVite = flary;

function toSchema(schema: unknown): Record<string, unknown> | undefined {
  try {
    return schema ? z.toJSONSchema(schema as never) as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
