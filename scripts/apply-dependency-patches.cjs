const path = require("node:path");
const { spawnSync } = require("node:child_process");

const installRoot = process.env.INIT_CWD || process.cwd();
let patchPackageCli;
try {
  patchPackageCli = require.resolve("patch-package/dist/index.js", {
    paths: [installRoot, process.cwd(), __dirname],
  });
} catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND") throw error;
  console.warn(
    "[flary] Skipped dependency patches because patch-package is not available in this linked install.",
  );
  process.exit(0);
}
const patchDirectory = path.resolve(__dirname, "../npm-patches");
const relativePatchDirectory = path.relative(installRoot, patchDirectory);
const result = spawnSync(
  process.execPath,
  [patchPackageCli, "--patch-dir", relativePatchDirectory],
  {
    cwd: installRoot,
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
