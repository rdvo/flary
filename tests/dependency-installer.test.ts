import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const flaryRoot = fileURLToPath(new URL("../", import.meta.url));
const { applyDependencyPatches, patchPlan } = require(
  path.join(flaryRoot, "scripts/apply-dependency-patches.cjs"),
);
const patchPackageCli = require.resolve("patch-package/dist/index.js");
const targets = [
  ["@cloudflare/codemode", "0.5.1"],
  ["@earendil-works/pi-ai", "0.83.0"],
  ["@flue/runtime-legacy", "1.0.0-beta.9"],
  ["turndown", "7.2.4"],
];

function fixture(t, layout) {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flary-installer-test-"));
  t.after(() => fs.rmSync(installRoot, { recursive: true, force: true }));
  const packageRoot = path.join(installRoot, "node_modules/flary");
  fs.mkdirSync(path.join(packageRoot, "npm-patches"), { recursive: true });
  for (const root of [installRoot, packageRoot])
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}');
  const copies = [];
  targets.forEach(([name, version], index) => {
    const filename = `${name.replaceAll("/", "+")}+${version}.patch`;
    const relative = `node_modules/${name}/value.txt`;
    fs.writeFileSync(
      path.join(packageRoot, "npm-patches", filename),
      `diff --git a/${relative} b/${relative}\n--- a/${relative}\n+++ b/${relative}\n@@ -1 +1 @@\n-before\n+after\n`,
    );
    for (const root of layout(index, installRoot, packageRoot)) {
      const directory = path.join(root, "node_modules", name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version }));
      fs.writeFileSync(path.join(directory, "value.txt"), "before\n");
      copies.push(directory);
    }
  });
  return { installRoot, packageRoot, patchPackageCli, copies };
}

for (const [name, layout] of [
  ["hoisted (CI layout)", (_i, root) => [root]],
  ["nested only", (_i, _root, nested) => [nested]],
  ["mixed", (i, root, nested) => [i % 2 ? nested : root]],
  ["both copies", (_i, root, nested) => [root, nested]],
]) {
  test(`Flary patches all four dependencies in ${name} and is idempotent`, (t) => {
    const input = fixture(t, layout);
    applyDependencyPatches(input);
    applyDependencyPatches(input);
    for (const directory of input.copies)
      assert.equal(fs.readFileSync(path.join(directory, "value.txt"), "utf8"), "after\n");
  });
}

test("Flary deduplicates symlinked copies", (t) => {
  const input = fixture(t, (_i, root) => [root]);
  for (const [name] of targets) {
    const nested = path.join(input.packageRoot, "node_modules", name);
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.symlinkSync(path.join(input.installRoot, "node_modules", name), nested, "dir");
  }
  const plan = patchPlan(input.packageRoot, input.installRoot);
  assert.equal([...plan.groups.values()].flat().length, 4);
});

test("missing required dependency fails before applying any patches", (t) => {
  const input = fixture(t, (_i, root) => [root]);
  fs.rmSync(input.copies[0], { recursive: true });
  assert.throws(() => applyDependencyPatches(input), /No installed copy found/);
  assert.equal(fs.readFileSync(path.join(input.copies[1], "value.txt"), "utf8"), "before\n");
});

test("dependency version mismatch fails before applying any patches", (t) => {
  const input = fixture(t, (_i, root) => [root]);
  fs.writeFileSync(path.join(input.copies[0], "package.json"), '{"version":"99.0.0"}');
  assert.throws(() => applyDependencyPatches(input), /patch requires 0.5.1/);
});

test("a rejected patch fails even outside CI", (t) => {
  const input = fixture(t, (_i, root) => [root]);
  fs.writeFileSync(path.join(input.copies[0], "value.txt"), "incompatible\n");
  const previous = process.env.CI;
  delete process.env.CI;
  try {
    assert.throws(() => applyDependencyPatches(input), /Dependency patches failed/);
  } finally {
    if (previous !== undefined) process.env.CI = previous;
  }
});

test("a different consumer version does not block Flary's nested dependency", (t) => {
  const input = fixture(t, (_i, root, nested) => [root, nested]);
  const consumerCopy = input.copies[0];
  fs.writeFileSync(path.join(consumerCopy, "package.json"), '{"version":"99.0.0"}');
  applyDependencyPatches(input);
  assert.equal(fs.readFileSync(path.join(consumerCopy, "value.txt"), "utf8"), "before\n");
  for (const directory of input.copies.slice(1)) {
    assert.equal(fs.readFileSync(path.join(directory, "value.txt"), "utf8"), "after\n");
  }
});

test("an incompatible nearest copy fails even when a compatible ancestor exists", (t) => {
  const input = fixture(t, (_i, root, nested) => [root, nested]);
  fs.writeFileSync(path.join(input.copies[1], "package.json"), '{"version":"99.0.0"}');
  assert.throws(() => applyDependencyPatches(input), /patch requires 0.5.1/);
  assert.equal(fs.readFileSync(path.join(input.copies[0], "value.txt"), "utf8"), "before\n");
});
