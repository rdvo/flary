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
      'const client = await import("flary/client");',
      'if (typeof client.createFlaryFunctionClient !== "function") throw new Error("Missing typed client export");',
    ].join("\n"),
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
run("npm", ["install", "--loglevel", "error"], starter);
run("npm", ["run", "build"], starter);

const generatedWrangler = JSON.parse(
  fs.readFileSync(path.join(starter, ".flue-vite.wrangler.jsonc"), "utf8"),
);
if (!generatedWrangler.exports?.FlaryRuntime) {
  throw new Error("The generated starter did not use Durable Object exports");
}
if ("migrations" in generatedWrangler) {
  throw new Error("The generated starter mixed exports with legacy migrations");
}

console.log(
  "Clean npm install verifies all function-first exports, builds the generated starter, and contains the pinned Flue/Pi patches.",
);
