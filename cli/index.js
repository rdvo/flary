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
          ],
        },
      ]);

      const { projectName, template } = answers;

      // Get paths
      const cwd = process.cwd();
      const starterPath = resolve(__dirname, "..", "starter");
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

      // Copy starter template contents
      try {
        // Read the contents of the starter directory
        const starterContents = await glob("**/*", {
          cwd: starterPath,
          dot: true,
          ignore: [
            "node_modules/**",
            ".git/**",
            "dist/**",
            "test-app/**",
            ".DS_Store",
            "tsconfig.tsbuildinfo",
            "pnpm-lock.yaml", // We'll stick with npm
            "*.log",
          ],
          nodir: false, // Include directories in the results
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

        // Create .env from .env.example if it exists
        const envExamplePath = join(starterPath, ".env.example");
        const envPath = join(projectDir, ".env");
        try {
          const envExample = readFileSync(envExamplePath, "utf8");
          writeFileSync(envPath, envExample);
        } catch (error) {
          console.log(
            chalk.yellow("⚠️ No .env.example found, skipping .env creation")
          );
        }

        // Create README.md
        const readmeContent = `# ${projectName}

A full-stack React application with Cloudflare Workers, built with Flary.

## Getting Started

1. Install dependencies:
\`\`\`bash
npm install
\`\`\`

2. Start the development server:
\`\`\`bash
npm run dev
\`\`\`

3. Open [http://localhost:5173](http://localhost:5173) in your browser.

## Features

- ⚡️ React + Vite for lightning-fast development
- 🔥 Cloudflare Workers for serverless functions
- 🎨 Tailwind CSS for styling
- 📦 TypeScript for type safety
- 🚀 Automatic deployments with Cloudflare

## Scripts

- \`npm run dev\` - Start development server
- \`npm run build\` - Build for production
- \`npm run preview\` - Preview production build locally
- \`npm run deploy\` - Deploy to Cloudflare Workers

## Project Structure

\`\`\`
${projectName}/
├── app/          # React application code
├── src/          # Worker and API routes
├── public/       # Static assets
└── ...config files
\`\`\`

## License

MIT
`;

        writeFileSync(join(projectDir, "README.md"), readmeContent);

        // Copy each file individually to maintain correct structure
        for (const file of starterContents) {
          const sourcePath = join(starterPath, file);
          const targetPath = join(projectDir, file);

          // Create parent directory if needed
          await mkdir(dirname(targetPath), { recursive: true });

          try {
            // Skip if it's just a directory
            if ((await glob(sourcePath)).length === 0) continue;

            // Copy the file or directory
            await cp(sourcePath, targetPath, { recursive: true });
          } catch (err) {
            // Only throw if it's not a directory exists error
            if (err.code !== "EISDIR") {
              throw err;
            }
          }
        }

        // Clean up any accidentally created nested project directory
        const nestedProjectDir = join(projectDir, projectName);
        try {
          const nestedStats = await stat(nestedProjectDir);
          if (nestedStats.isDirectory()) {
            await rm(nestedProjectDir, { recursive: true, force: true });
          }
        } catch (err) {
          // Ignore if nested directory doesn't exist
          if (err.code !== "ENOENT") {
            throw err;
          }
        }

        console.log(chalk.green("✓ Copied template files successfully"));
      } catch (error) {
        console.error(
          chalk.red("Failed to copy starter template:", error.message)
        );
        throw new Error(
          "Failed to initialize project. Please ensure you have proper permissions and try again."
        );
      }

      // Update package.json
      try {
        const projPackageJsonPath = join(projectDir, "package.json");
        const packageData = JSON.parse(
          readFileSync(projPackageJsonPath, "utf8")
        );
        packageData.name = projectName;
        writeFileSync(
          projPackageJsonPath,
          JSON.stringify(packageData, null, 2)
        );

        // Update wrangler.jsonc with project name
        const wranglerPath = join(projectDir, "wrangler.jsonc");
        const wranglerContent = readFileSync(wranglerPath, "utf8");
        const updatedWranglerContent = wranglerContent.replace(
          /"name":\s*"[^"]*"/,
          `"name": "${projectName}"`
        );
        writeFileSync(wranglerPath, updatedWranglerContent);
      } catch (error) {
        console.error(
          chalk.red("Failed to update configuration files:", error.message)
        );
        throw new Error("Failed to configure project. Please try again.");
      }

      console.log(chalk.green("\n✨ Project created successfully!"));
      console.log(chalk.yellow("\nNext steps:"));
      console.log(chalk.white(`  1. cd ${projectName}`));
      console.log(chalk.white("  2. npm install"));
      console.log(chalk.white("  3. npm run dev"));

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
