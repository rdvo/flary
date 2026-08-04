const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repository = path.resolve(__dirname, "..");
const manifest = require(path.join(repository, "package.json"));
const version = process.env.FLARY_RELEASE_VERSION || manifest.version;
if (version !== manifest.version) {
  throw new Error(
    `Release version ${version} does not match package version ${manifest.version}`,
  );
}

(async () => {
  const engine = await import(
    pathToFileURL(path.join(repository, "dist/harness/session/engine.js")).href
  );
  if (!engine.requiresFlue2StableRelease(version)) {
    console.log(`Release gate accepts ${version} without the stable 0.8 engine gate.`);
    return;
  }
  const loaded = await engine.loadPinnedFlue2Runtime();
  engine.assertInteractiveSessionEngine({
    pin: {
      id: "flue-2",
      version: loaded.version,
      revision: `npm:${loaded.version}`,
    },
    capabilities: loaded.capabilities,
  });
  console.log(`Stable ${version} uses a complete Flue ${loaded.version} session engine.`);
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
