const fs = require("node:fs");
const path = require("node:path");

const ORIGINAL = `function buildConversationContextEntries(conversation, options = {}) {
\tconst path = getActiveConversationPath(conversation);`;

const PATCHED = `function buildConversationContextEntries(conversation, options = {}) {
\tconst canonicalPath = getActiveConversationPath(conversation);
\tconst rollbackIndex = canonicalPath.findLastIndex((entry) => entry.type === "message" && entry.message.role === "signal" && entry.message.type === "flary_rollback");
\tconst rollback = rollbackIndex >= 0 ? canonicalPath[rollbackIndex] : void 0;
\tconst targetEntryId = rollback?.type === "message" && rollback.message.role === "signal" ? rollback.message.attributes?.targetEntryId : void 0;
\tconst targetIndex = typeof targetEntryId === "string" ? canonicalPath.findIndex((entry) => entry.id === targetEntryId) : -1;
\tconst path = rollbackIndex >= 0 && targetIndex >= 0 && targetIndex < rollbackIndex ? [
\t\t...canonicalPath.slice(0, rollback?.type === "message" && rollback.message.role === "signal" && rollback.message.attributes?.excludeTarget === "true" ? targetIndex : targetIndex + 1),
\t\t...canonicalPath.slice(rollbackIndex)
\t] : canonicalPath;`;

function applyFlue2SessionPatch(searchPaths) {
  const packageRoot = searchPaths
    .map((root) => path.resolve(root, "node_modules/@flue/runtime-v2"))
    .concat(path.resolve(__dirname, "../node_modules/@flue/runtime-v2"))
    .find((root) => fs.existsSync(path.join(root, "package.json")));
  if (!packageRoot) return false;
  const directory = path.join(packageRoot, "dist");
  const dispatchFile = fs
    .readdirSync(directory)
    .find((name) => /^dispatch-[A-Za-z0-9_-]+\.mjs$/.test(name));
  if (!dispatchFile) throw new Error("[flary] Could not find the pinned Flue 2 dispatch module.");
  const file = path.join(directory, dispatchFile);
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(PATCHED)) return true;
  if (!source.includes(ORIGINAL)) {
    throw new Error("[flary] Flue 2.0.2 changed. The session rollback patch did not apply.");
  }
  fs.writeFileSync(file, source.replace(ORIGINAL, PATCHED));
  return true;
}

module.exports = { applyFlue2SessionPatch };
