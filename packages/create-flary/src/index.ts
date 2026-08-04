#!/usr/bin/env node

import { runFlaryCli } from "flary/cli";

const args = process.argv.slice(2);
const target = args.find((value) => !value.startsWith("--"));

console.warn(
  '"create-flary" is now an alias. Use "npx flary create" for new projects.',
);

const run = args.includes("--provision")
  ? Promise.reject(
      new Error(
        '"--provision" is no longer supported. Create the starter, then run its deploy command.',
      ),
    )
  : runFlaryCli(["create", ...(target ? [target] : [])]);

void run.catch(
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
