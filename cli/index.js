#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { rename, mkdir } from "fs/promises";
import { glob } from "glob";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json
const packageJsonPath = resolve(__dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const version = packageJson.version;

const program = new Command();

// Validate v0.dev URL format
function validateV0Url(url) {
  const v0UrlPattern =
    /^https:\/\/v0\.dev\/chat\/[a-zA-Z0-9\/_-]+(\?token=[\w.-]+)?$/;
  if (!v0UrlPattern.test(url)) {
    throw new Error(
      "Invalid v0.dev URL format. Expected format: https://v0.dev/chat/..."
    );
  }
  return url;
}

program
  .version(version)
  .description("Flary CLI - Tools for Cloudflare Workers");

// Add v0.dev command
program
  .command("v0 <url>")
  .description("Import components from v0.dev and organize files")
  .option(
    "-d, --dir <directory>",
    "Target subdirectory for components (relative to src/)",
    "components"
  )
  .action(async (url, options) => {
    try {
      // Validate URL
      validateV0Url(url);

      console.log(chalk.blue("🚀 Importing v0.dev components..."));

      // Run the shadcn command
      execSync(`npx shadcn@latest add "${url}"`, { stdio: "inherit" });

      // Create src and target directories
      const targetDir = join("src", options.dir);
      await mkdir(targetDir, { recursive: true });

      // Move all generated .tsx files to target directory
      const tsxFiles = await glob("*.tsx", { ignore: ["src/**"] });

      if (tsxFiles.length === 0) {
        console.log(chalk.yellow("ℹ No new components were generated"));
        process.exit(0);
      }

      console.log(
        chalk.yellow(
          `📦 Moving ${tsxFiles.length} component${
            tsxFiles.length === 1 ? "" : "s"
          } to ${targetDir}/...`
        )
      );

      for (const file of tsxFiles) {
        try {
          await rename(file, join(targetDir, file));
          console.log(chalk.green(`✓ Moved ${file} to ${targetDir}/${file}`));
        } catch (err) {
          console.error(chalk.red(`Error moving ${file}: ${err.message}`));
        }
      }

      console.log(
        chalk.green(
          `✨ Successfully imported ${tsxFiles.length} component${
            tsxFiles.length === 1 ? "" : "s"
          }!`
        )
      );
    } catch (error) {
      console.error(chalk.red("Error:", error.message));
      process.exit(1);
    }
  });

program.parse(process.argv);
