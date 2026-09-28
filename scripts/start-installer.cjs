const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const MIN_NODE_VERSION = [22, 19, 0];
const PINNED_PACKAGE_MANAGER = "pnpm@8.15.4";
const repository = path.resolve(__dirname, "..");

function formatVersion(version) {
  return version.join(".");
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? match.slice(1).map(Number) : undefined;
}

function compareVersions(left, right) {
  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(command, args, options = {}) {
  const shell = process.platform === "win32";
  // Windows package-manager shims need cmd.exe. Only fixed command tokens may
  // reach this shell; the user-selected target is passed directly to Node below.
  if (shell && ![command, ...args].every((value) => /^[\w@./=-]+$/.test(value))) {
    throw new Error("Unsupported package-manager command argument.");
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repository,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
    shell,
  });
  return result;
}

function commandWorks(command, args) {
  const result = run(command, args, { stdio: "pipe" });
  if (result.error || result.status !== 0) return false;
  return true;
}

function readPackage() {
  const file = path.join(repository, "package.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Flary setup could not read ${file}. Run this command from a complete clone, then try again. ${error instanceof Error ? error.message : ""}`,
    );
  }
}

function checkNode() {
  const detected = parseVersion(process.versions.node);
  if (!detected || compareVersions(detected, MIN_NODE_VERSION) < 0) {
    throw new Error(
      `Flary setup needs Node.js ${formatVersion(MIN_NODE_VERSION)} or newer. Detected Node.js ${process.versions.node}. Install a maintained Node.js 22 release, then run \`npm run setup\` again.`,
    );
  }
}

function packageManagerRunner(packageJson) {
  if (packageJson.packageManager !== PINNED_PACKAGE_MANAGER) {
    throw new Error(
      `This checkout expects ${PINNED_PACKAGE_MANAGER}. Its package.json declares ${packageJson.packageManager ?? "no package manager"}. Use a complete checkout and run \`npm run setup\` again.`,
    );
  }

  const pnpm = commandName("pnpm");
  if (commandWorks(pnpm, ["--version"])) {
    const versionResult = run(pnpm, ["--version"], { stdio: "pipe" });
    const version = typeof versionResult.stdout === "string" ? versionResult.stdout.trim() : "";
    if (version === "8.15.4") return { command: pnpm, prefix: [] };
  }

  // Corepack selects the packageManager entry without changing global shims or
  // configuration. Explicitly naming the version also protects a checkout
  // copied beside a package with a different packageManager field.
  const corepack = commandName("corepack");
  if (commandWorks(corepack, [PINNED_PACKAGE_MANAGER, "--version"])) {
    return { command: corepack, prefix: [PINNED_PACKAGE_MANAGER] };
  }

  // Node distributions without Corepack can still bootstrap the exact pinned
  // manager through npm's temporary runner. This does not install a global
  // package-manager shim.
  const npx = commandName("npx");
  if (commandWorks(npx, ["--yes", PINNED_PACKAGE_MANAGER, "--version"])) {
    return { command: npx, prefix: ["--yes", PINNED_PACKAGE_MANAGER] };
  }

  throw new Error(
    `Flary setup needs pnpm 8.15.4 to install this checkout. Install pnpm 8.15.4 or use a Node.js distribution with Corepack enabled, then run \`npm run setup\` again. The launcher does not change global package-manager settings.`,
  );
}

function isInside(directory, candidate) {
  const caseFolded = process.platform === "darwin" || process.platform === "win32";
  const base = caseFolded ? directory.toLowerCase() : directory;
  const target = caseFolded ? candidate.toLowerCase() : candidate;
  const relative = path.relative(base, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function resolveTarget(args) {
  if (args.length > 1) {
    throw new Error("Usage: npm run setup -- [project-directory]");
  }
  const configured = args[0] ?? process.env.FLARY_QUICKSTART_TARGET;
  const target = path.resolve(configured || path.join(os.homedir(), "flary-project"));
  if (isInside(repository, target)) {
    throw new Error(
      `The quickstart project must be outside the Flary checkout. Choose a directory beside it or use \`npm run setup -- /path/to/flary-project\`.`,
    );
  }
  return target;
}

function needsDependencies() {
  const tsx = path.join(repository, "node_modules", ".bin", "tsx");
  const installedLockfile = path.join(repository, "node_modules", ".pnpm", "lock.yaml");
  const lockfile = path.join(repository, "pnpm-lock.yaml");
  if (!fs.existsSync(tsx) || !fs.existsSync(installedLockfile) || !fs.existsSync(lockfile)) {
    return true;
  }
  try {
    return fs.readFileSync(lockfile, "utf8") !== fs.readFileSync(installedLockfile, "utf8");
  } catch {
    return true;
  }
}

function needsBuild() {
  const outputs = ["cli.js", "cli-api.js", "quickstart.js"];
  // A later UI bundle can be added without making older checkouts fail to
  // start. If its source exists, require the matching build output too.
  if (
    fs.existsSync(path.join(repository, "src", "quickstart-ui.ts")) ||
    fs.existsSync(path.join(repository, "src", "quickstart-ui.tsx"))
  ) {
    outputs.push("quickstart-ui.js");
  }
  if (outputs.some((file) => !fs.existsSync(path.join(repository, "dist", file)))) return true;

  const outputTime = Math.min(
    ...outputs.map((file) => fs.statSync(path.join(repository, "dist", file)).mtimeMs),
  );
  const inputs = [
    "build.ts",
    "tsconfig.build.json",
    "src/cli.ts",
    "src/cli-api.ts",
    "src/quickstart.ts",
  ];
  if (fs.existsSync(path.join(repository, "src", "quickstart-ui.ts")))
    inputs.push("src/quickstart-ui.ts");
  if (fs.existsSync(path.join(repository, "src", "quickstart-ui.tsx")))
    inputs.push("src/quickstart-ui.tsx");
  return inputs.some((file) => fs.statSync(path.join(repository, file)).mtimeMs > outputTime);
}

function runPackageManager(manager, args) {
  return run(manager.command, [...manager.prefix, ...args], { cwd: repository });
}

function installDependencies(manager) {
  process.stdout.write("Preparing Flary dependencies…\n");
  const result = runPackageManager(manager, ["install", "--frozen-lockfile"]);
  if (result.error || result.status !== 0) {
    throw new Error(
      "Flary could not install dependencies with pnpm 8.15.4. Check your network and registry access, then rerun `npm run setup`. The checkout was left in place.",
    );
  }
}

function buildCli(manager) {
  process.stdout.write("Building the local installer…\n");
  // Run the build entry directly so a setup refresh never removes an existing
  // ignored dist directory as a side effect of the package's clean build
  // script. The generated CLI files are overwritten in place.
  const result = runPackageManager(manager, ["exec", "tsx", "build.ts"]);
  if (result.error || result.status !== 0) {
    throw new Error(
      "Flary could not build the local quickstart CLI. Fix the build error above, then rerun `npm run setup`.",
    );
  }
}

function launchQuickstart(target) {
  process.stdout.write(
    "Opening setup in your browser. Keep this terminal open while you set up your assistant.\n",
  );
  const cli = path.join(repository, "dist", "cli.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "quickstart", target], {
      cwd: repository,
      env: { ...process.env },
      stdio: "inherit",
    });
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      callback();
    };
    const onSignal = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    child.once("error", (error) =>
      finish(() =>
        reject(
          new Error(
            `Flary could not start the local quickstart. Check that ${cli} exists, then rerun \`npm run setup\`. ${error.message}`,
          ),
        ),
      ),
    );
    child.once("close", (code, signal) =>
      finish(() => {
        if (signal === "SIGINT") process.exitCode = 130;
        else if (signal === "SIGTERM") process.exitCode = 143;
        else if (code !== 0) process.exitCode = code ?? 1;
        resolve();
      }),
    );
  });
}

function printHelp() {
  process.stdout.write(
    "Usage: npm run setup -- [project-directory]\n\n" +
      "Checks Node.js, installs this checkout with pnpm 8.15.4 when needed, builds the CLI, and opens the local quickstart.\n" +
      "The default generated project directory is ~/flary-project.\n",
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  checkNode();
  const packageJson = readPackage();
  const target = resolveTarget(args);
  const install = needsDependencies();
  const build = needsBuild();
  if (!install && !build) {
    await launchQuickstart(target);
    return;
  }

  const manager = packageManagerRunner(packageJson);
  if (install) installDependencies(manager);
  if (build || install) buildCli(manager);
  await launchQuickstart(target);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  MIN_NODE_VERSION,
  PINNED_PACKAGE_MANAGER,
  compareVersions,
  isInside,
  parseVersion,
};
