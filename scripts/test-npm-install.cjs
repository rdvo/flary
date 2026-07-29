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

console.log("Clean npm install contains the pinned Flue and Pi patches.");
