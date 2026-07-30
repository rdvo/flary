import { runFlaryCli } from "./cli-api.js";

void runFlaryCli(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
