const { spawnSync } = require("node:child_process");

const required = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "FLARY_OPENAI_CACHE_TEST_MODEL",
  "FLARY_ANTHROPIC_CACHE_TEST_MODEL",
  "FLARY_E2E_BASE_URL",
  "FLARY_E2E_TOKEN",
  "FLARY_E2E_APP_ID",
  "FLARY_E2E_ORGANIZATION_ID",
  "FLARY_E2E_AGENT_ID",
  "FLARY_E2E_THREAD_ID",
  "FLARY_E2E_MODEL_JSON",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Live provider recovery tests need: ${missing.join(", ")}`);
  process.exit(2);
}

const result = spawnSync(
  process.platform === "win32" ? "tsx.cmd" : "tsx",
  [
    "--test",
    "tests/integration/provider-cache.test.ts",
    "tests/integration/flary-thread-cache-live.test.ts",
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
