#!/usr/bin/env node

import * as React from "react";
import { Command } from "commander";
import chalk from "chalk";
import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { rename, mkdir, cp, stat, rm } from "fs/promises";
import { glob } from "glob";
import inquirer from "inquirer";

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

// Add init command
program
  .command("init")
  .description("Initialize a new Flary project")
  .action(async () => {
    try {
      // Get project details
      const answers = await inquirer.prompt([
        {
          type: "input",
          name: "projectName",
          message: "What is your project name?",
          default: "my-flary-app",
          validate: (input) => {
            if (/^[a-zA-Z0-9-_]+$/.test(input)) return true;
            return "Project name may only include letters, numbers, underscores and hyphens";
          },
        },
        {
          type: "list",
          name: "template",
          message: "Which template would you like to use?",
          choices: [
            {
              name: "Full-Stack React App (with Cloudflare Workers)",
              value: "fullstack",
            },
            {
              name: "MCP Server (Model Context Protocol)",
              value: "mcp",
            },
          ],
        },
      ]);

      const { projectName, template } = answers;

      // Get paths
      const cwd = process.cwd();
      const templatePath = resolve(
        __dirname,
        "templates",
        template === "mcp" ? "mcp" : "fullstack"
      );
      const projectDir = resolve(cwd, projectName);

      console.log(chalk.blue("\n🚀 Creating your Flary project..."));

      // Check if directory already exists
      try {
        await mkdir(projectDir, { recursive: true });
      } catch (error) {
        if (error.code === "EEXIST") {
          throw new Error(
            `Directory ${projectName} already exists. Please choose a different name or delete the existing directory.`
          );
        }
        throw error;
      }

      // Copy template contents
      try {
        // Read the contents of the template directory
        const templateContents = await glob("**/*", {
          cwd: templatePath,
          dot: true,
          ignore: [
            "node_modules/**",
            ".git/**",
            "dist/**",
            "test-app/**",
            ".DS_Store",
            "tsconfig.tsbuildinfo",
            "pnpm-lock.yaml",
            "*.log",
          ],
          nodir: false,
        });

        // Create the project directory first
        await mkdir(projectDir, { recursive: true });

        // Create .vscode directory with settings
        const vscodePath = join(projectDir, ".vscode");
        await mkdir(vscodePath, { recursive: true });

        const vscodeSettings = {
          "editor.formatOnSave": true,
          "editor.defaultFormatter": "esbenp.prettier-vscode",
          "editor.codeActionsOnSave": {
            "source.fixAll.eslint": true,
          },
          "typescript.tsdk": "node_modules/typescript/lib",
          "typescript.enablePromptUseWorkspaceTsdk": true,
          "[typescript]": {
            "editor.defaultFormatter": "esbenp.prettier-vscode",
          },
          "[typescriptreact]": {
            "editor.defaultFormatter": "esbenp.prettier-vscode",
          },
        };

        writeFileSync(
          join(vscodePath, "settings.json"),
          JSON.stringify(vscodeSettings, null, 2)
        );

        // Copy each file individually to maintain correct structure
        for (const file of templateContents) {
          const sourcePath = join(templatePath, file);
          const targetPath = join(projectDir, file);

          // Create parent directory if needed
          await mkdir(dirname(targetPath), { recursive: true });

          try {
            // Skip if it's just a directory
            if ((await glob(sourcePath)).length === 0) continue;

            // Copy the file or directory
            await cp(sourcePath, targetPath, { recursive: true });
          } catch (err) {
            if (err.code !== "EISDIR") {
              throw err;
            }
          }
        }

        // Update package.json
        const projPackageJsonPath = join(projectDir, "package.json");
        const packageData = JSON.parse(
          readFileSync(projPackageJsonPath, "utf8")
        );
        packageData.name = projectName;
        writeFileSync(
          projPackageJsonPath,
          JSON.stringify(packageData, null, 2)
        );

        // Update wrangler.jsonc with project name and add Durable Objects config if MCP template
        const wranglerPath = join(projectDir, "wrangler.jsonc");
        let wranglerContent = readFileSync(wranglerPath, "utf8");
        wranglerContent = wranglerContent.replace(
          /"name":\s*"[^"]*"/,
          `"name": "${projectName}"`
        );

        if (template === "mcp") {
          // Add Durable Objects configuration if it doesn't exist
          if (!wranglerContent.includes("durable_objects")) {
            const durableConfig = `
  "durable_objects": {
    "bindings": [
      {
        "name": "McpObject",
        "class_name": "McpObject"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_classes": ["McpObject"]
    }
  ],`;
            wranglerContent = wranglerContent.replace(
              /{([^}]*)}/,
              `{$1${durableConfig}}`
            );
          }

          // Update MCP instance name in src/index.ts
          const indexPath = join(projectDir, "src", "index.ts");
          let indexContent = readFileSync(indexPath, "utf8");
          indexContent = indexContent.replace(
            /name:\s*"[^"]*"/,
            `name: "${projectName}"`
          );
          writeFileSync(indexPath, indexContent);
        }

        writeFileSync(wranglerPath, wranglerContent);

        console.log(chalk.green("✓ Copied template files successfully"));
      } catch (error) {
        console.error(
          chalk.red("Failed to copy starter template:", error.message)
        );
        throw new Error(
          "Failed to initialize project. Please ensure you have proper permissions and try again."
        );
      }

      console.log(chalk.green("\n✨ Project created successfully!"));

      if (template === "mcp") {
        console.log(chalk.yellow("\nGet started:"));
        console.log(chalk.white(`cd ${projectName} && npm install`));
        console.log(chalk.white("\nUpdate src/index.ts with your tools"));
        console.log(chalk.white("Change the auth token in MCP config"));
        console.log(chalk.yellow("\nCommands:"));
        console.log(chalk.white("npm run dev     # local development"));
        console.log(chalk.white("wrangler deploy # deploy to production"));
      } else {
        console.log(chalk.yellow("\nGet started:"));
        console.log(chalk.white(`cd ${projectName} && npm install`));
        console.log(chalk.white("npm run dev"));
      }

      console.log(chalk.blue("\nHappy coding! 🎉"));
    } catch (error) {
      console.error(chalk.red("\nError:", error.message));
      process.exit(1);
    }
  });

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
