const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repository = path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "flary-npm-install-"));
const consumer = path.join(temporary, "consumer");
fs.mkdirSync(consumer);

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    if (options.quiet) {
      process.stderr.write(result.stdout || "");
      process.stderr.write(result.stderr || "");
    }
    process.exit(result.status ?? 1);
  }
}

run("npm", ["run", "build"], repository);
run("npm", ["pack", "--pack-destination", temporary, "--silent"], repository);
run("npm", ["init", "-y"], consumer, { quiet: true });
const manifest = require(path.join(repository, "package.json"));
const tarball = path.join(temporary, `flary-${manifest.version}.tgz`);
run("npm", ["install", tarball, "--loglevel", "error"], consumer);
run("npm", ["audit", "--audit-level=high"], consumer);

const flue = fs.readFileSync(
  path.join(
    consumer,
    "node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs",
  ),
  "utf8",
);
const pi = fs.readFileSync(
  path.join(
    consumer,
    "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js",
  ),
  "utf8",
);
if (!flue.includes("activeCacheRetention")) {
  throw new Error("The clean npm install did not apply the Flue cache patch");
}
if (!pi.includes("effectiveSessionId")) {
  throw new Error("The clean npm install did not apply the Pi cache patch");
}

run(
  "node",
  [
    "--input-type=module",
    "--eval",
    [
      'const mcp = await import("flary/mcp");',
      'if (typeof mcp.createMcpTools !== "function") throw new Error("Missing createMcpTools export");',
      'if (typeof mcp.createMcpToolset !== "function") throw new Error("Missing createMcpToolset export");',
      'const cloudflare = await import("flary/cloudflare");',
      'if (typeof cloudflare.SqliteToolExecutionJournal !== "function") throw new Error("Missing SqliteToolExecutionJournal export");',
      'const functions = await import("flary/functions");',
      'if (typeof functions.flary !== "function") throw new Error("Missing functions flary export");',
      'const vite = await import("flary/vite");',
      'if (typeof vite.flaryVite !== "function") throw new Error("Missing flaryVite export");',
      'const evaluations = await import("flary/evaluations");',
      'if (typeof evaluations.runEvaluation !== "function") throw new Error("Missing evaluation export");',
      'const providers = await import("flary/providers");',
      'if (typeof providers.DeterministicModelRouter !== "function") throw new Error("Missing routing export");',
      'if (typeof providers.createModelOperations !== "function") throw new Error("Missing model operations export");',
      'const client = await import("flary/client");',
      'if (typeof client.createFlaryFunctionClient !== "function") throw new Error("Missing typed client export");',
      'const flueTools = await import("flary/flue");',
      'if (typeof flueTools.createFlaryToolset !== "function") throw new Error("Missing createFlaryToolset export");',
      'if (typeof cloudflare.createCloudflareWorkspaceTarget !== "function") throw new Error("Missing Cloudflare workspace target export");',
      'if (typeof cloudflare.createCloudflareCodeMode !== "function") throw new Error("Missing Cloudflare Code Mode export");',
      'if (typeof cloudflare.createCloudflareSandboxToolset !== "function") throw new Error("Missing Cloudflare Sandbox toolset export");',
      'if (typeof cloudflare.CloudflareProviderOAuthPersistence !== "function") throw new Error("Missing provider OAuth persistence export");',
      'if (typeof cloudflare.CloudflareMcpOAuthConnections !== "function") throw new Error("Missing MCP OAuth persistence export");',
      'if (typeof providers.CloudflareWorkersAIAdapter !== "function") throw new Error("Missing Workers AI adapter export");',
    ].join("\n"),
  ],
  consumer,
);

const typeConsumer = path.join(consumer, "toolset-consumer.ts");
fs.writeFileSync(
  typeConsumer,
  [
    'import { createFlaryToolset, defineFlaryAgent } from "flary/flue";',
    'import { createCloudflareWorkspaceTarget } from "flary/cloudflare";',
    "",
    "interface Env {",
    "  PROJECT_WORKSPACES: {",
    "    idFromName(name: string): { toString(): string };",
    "    get(id: { toString(): string }): { fetch(request: Request): Promise<Response> };",
    "  };",
    "  WORKSPACE_BLOBS: unknown;",
    "}",
    "",
    "export default defineFlaryAgent<Env>({",
    "  resolveContext: () => ({",
    '    tenantId: "org_1",',
    '    applicationId: "app_1",',
    '    projectId: "project_1",',
    '    agentId: "agent_1",',
    '    revisionId: "revision_1",',
    '    identity: { id: "user_1", kind: "user" },',
    "    roles: [],",
    "    scopes: [],",
    "  }),",
    "  resolveAgent: () => ({",
    '    agentId: "agent_1",',
    '    revisionId: "revision_1",',
    '    instructions: "Work on the project.",',
    '    model: { provider: "openai", model: "gpt-5" },',
    '    capabilities: ["workspace.read"],',
    "  }),",
    '  resolveModel: () => "openai:gpt-5",',
    "  resolveTools: ({ env, trusted, agent, id }) =>",
    "    createFlaryToolset({",
    "      scope: {",
    "        tenantId: trusted.tenantId,",
    "        appId: trusted.applicationId,",
    '        projectId: trusted.projectId ?? "default",',
    "        workspaceId: id,",
    '        branch: "main",',
    "        userId: trusted.identity.id,",
    "        runId: id,",
    "      },",
    "      capabilities: agent.capabilities,",
    "      workspace: createCloudflareWorkspaceTarget({",
    "        binding: env.PROJECT_WORKSPACES,",
    "        blobs: env.WORKSPACE_BLOBS,",
    "      }),",
    "      sandbox: { enabled: false },",
    "    }).then((result) => result.tools),",
    "});",
    "",
  ].join("\n"),
);
run(
  path.join(repository, "node_modules/.bin/tsc"),
  [
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--target",
    "ES2022",
    "--module",
    "ESNext",
    "--moduleResolution",
    "bundler",
    typeConsumer,
  ],
  consumer,
);

const flaryBin = path.join(consumer, "node_modules/.bin/flary");
run(flaryBin, ["help"], consumer);

const starter = path.join(temporary, "starter");
run(flaryBin, ["create", starter], consumer);
const starterManifestPath = path.join(starter, "package.json");
const starterManifest = JSON.parse(fs.readFileSync(starterManifestPath, "utf8"));
starterManifest.dependencies.flary = tarball;
fs.writeFileSync(
  starterManifestPath,
  `${JSON.stringify(starterManifest, null, 2)}\n`,
);
const starterAuth = fs.readFileSync(
  path.join(starter, "src", "flary.ts"),
  "utf8",
);
if (starterAuth.includes("tenantId: bindings.APP_ENV")) {
  throw new Error("The generated starter still trusts APP_ENV as a tenant");
}
if (
  !starterAuth.includes('const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])') ||
  !starterAuth.includes("return undefined")
) {
  throw new Error("The generated starter does not fail closed outside loopback");
}
run("npm", ["install", "--loglevel", "error"], starter);
run("npm", ["audit", "--audit-level=high"], starter);
run("npm", ["run", "build"], starter);

for (const name of [".dev.vars", ".env"]) {
  if (findFiles(path.join(starter, "dist"), name).length > 0) {
    throw new Error(`The built starter contains a secret environment file: ${name}`);
  }
}

const dashboard = path.join(temporary, "dashboard");
fs.cpSync(
  path.join(consumer, "node_modules/flary/templates/dashboard"),
  dashboard,
  { recursive: true },
);
fs.renameSync(path.join(dashboard, "gitignore"), path.join(dashboard, ".gitignore"));
const dashboardManifestPath = path.join(dashboard, "package.json");
const dashboardManifest = JSON.parse(fs.readFileSync(dashboardManifestPath, "utf8"));
dashboardManifest.dependencies.flary = tarball;
fs.writeFileSync(dashboardManifestPath, `${JSON.stringify(dashboardManifest, null, 2)}\n`);
run("npm", ["install", "--loglevel", "error"], dashboard);
run("npm", ["audit", "--audit-level=high"], dashboard);
run("npm", ["run", "build"], dashboard);
if (!fs.existsSync(path.join(dashboard, "migrations/0001_dashboard.sql"))) {
  throw new Error("The dashboard template is missing its first-owner migration");
}

const generatedWrangler = JSON.parse(
  fs.readFileSync(path.join(starter, ".flue-vite.wrangler.jsonc"), "utf8"),
);
if (!generatedWrangler.exports?.FlaryRuntime) {
  throw new Error("The generated starter did not use Durable Object exports");
}
if ("migrations" in generatedWrangler) {
  throw new Error("The generated starter mixed exports with legacy migrations");
}

function findFiles(directory, name) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(file, name));
    else if (entry.name === name) found.push(file);
  }
  return found;
}

for (const file of findFiles(path.join(starter, "dist"), "wrangler.json")) {
  const output = JSON.parse(fs.readFileSync(file, "utf8"));
  if (output.exports && Object.keys(output.exports).length > 0 && "migrations" in output) {
    throw new Error(`The built starter mixed exports with legacy migrations: ${file}`);
  }
}

console.log(
  "Clean npm install verifies public exports, builds both templates, and contains the pinned Flue/Pi patches.",
);
