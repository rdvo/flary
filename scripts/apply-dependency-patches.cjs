const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");
const { applyFlue2SessionPatch } = require("./apply-flue2-session-patch.cjs");

// Search the same ancestor node_modules directories as Node, without resolving
// package.json through exports (several dependencies do not export it).
function dependencyRoots(searchPaths) {
  const roots = new Set();
  for (let root of searchPaths) {
    root = path.resolve(root);
    while (true) {
      if (path.basename(root) !== "node_modules") roots.add(root);
      const parent = path.dirname(root);
      if (parent === root) break;
      root = parent;
    }
  }
  return [...roots];
}

function patchPlan(packageRoot, installRoot) {
  const patchDirectory = path.join(packageRoot, "npm-patches");
  const roots = dependencyRoots([packageRoot, installRoot]);
  const groups = new Map();
  for (const filename of fs
    .readdirSync(patchDirectory)
    .filter((name) => name.endsWith(".patch"))
    .sort()) {
    const parts = filename.slice(0, -6).split("+");
    const version = parts.pop();
    const name = parts.join("/");
    const seen = new Set();
    for (const root of roots) {
      const directory = path.join(root, "node_modules", name);
      const manifestPath = path.join(directory, "package.json");
      if (!fs.existsSync(manifestPath)) continue;
      const realPath = fs.realpathSync(directory);
      if (seen.has(realPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.version !== version) {
        // The nearest installed copy is the one Flary resolves. It must match.
        // Other consumer copies may legitimately use a different version.
        if (seen.size) continue;
        throw new Error(
          `[flary] ${name} at ${directory} is ${manifest.version}; patch requires ${version}.`,
        );
      }
      seen.add(realPath);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(filename);
    }
    if (!seen.size)
      throw new Error(`[flary] No installed copy found for required patch ${filename}.`);
  }
  if (!groups.size) throw new Error("[flary] No dependency patches found.");
  return { patchDirectory, groups, roots };
}

function applyDependencyPatches({
  packageRoot = path.resolve(__dirname, ".."),
  installRoot = process.env.INIT_CWD || process.cwd(),
  patchPackageCli,
} = {}) {
  const roots = dependencyRoots([installRoot, packageRoot]);
  // Keep the canonical Flue 2 patch, including separately installed copies.
  for (const root of roots) {
    const manifest = path.join(root, "node_modules/@flue/runtime/package.json");
    if (
      fs.existsSync(manifest) &&
      JSON.parse(fs.readFileSync(manifest, "utf8")).version.startsWith("2.")
    ) {
      applyFlue2SessionPatch([root]);
    }
  }
  // pnpm already applies the manifest's patchedDependencies.
  if (path.basename(process.env.npm_execpath || "").startsWith("pnpm")) return;

  const plan = patchPlan(packageRoot, installRoot);
  patchPackageCli ??= createRequire(path.join(packageRoot, "package.json")).resolve(
    "patch-package/dist/index.js",
  );
  for (const [root, filenames] of plan.groups) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "flary-patches-"));
    try {
      for (const filename of filenames) {
        fs.copyFileSync(path.join(plan.patchDirectory, filename), path.join(temporary, filename));
      }
      const result = spawnSync(
        process.execPath,
        [patchPackageCli, "--error-on-fail", "--patch-dir", path.relative(root, temporary)],
        { cwd: root, stdio: "inherit" },
      );
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(`[flary] Dependency patches failed at ${root} (exit ${result.status}).`);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}

module.exports = { dependencyRoots, patchPlan, applyDependencyPatches };
if (require.main === module) applyDependencyPatches();
