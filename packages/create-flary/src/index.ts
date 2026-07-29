#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Options = {
  target: string;
  name?: string;
  workerName?: string;
  appUrl?: string;
  provision: boolean;
  yes: boolean;
};

type ProjectConfig = {
  name: string;
  workerName: string;
  appUrl: string;
  databaseName: string;
  bucketName: string;
  databaseId?: string;
};

type CommandOptions = {
  cwd: string;
  input?: string;
  stream?: boolean;
};

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const templateRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/cloud",
);

function parseArgs(argv: string[]): Options {
  const positional = argv.find((value) => !value.startsWith("--"));
  const get = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    target: resolve(process.cwd(), positional ?? "flary-app"),
    name: get("--name"),
    workerName: get("--worker-name"),
    appUrl: get("--app-url"),
    provision: argv.includes("--provision"),
    yes: argv.includes("--yes"),
  };
}

type PromptReader = {
  question(question: string): Promise<string>;
};

async function ask(
  reader: PromptReader,
  question: string,
  fallback: string,
): Promise<string> {
  const answer = (await reader.question(`${question} [${fallback}] `)).trim();
  return answer || fallback;
}

function safeWorkerName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "flary-app"
  );
}

function resourceName(workerName: string, suffix: string): string {
  const value = `${workerName}-${suffix}`;
  return safeWorkerName(value).slice(0, 63);
}

function normalizeAppUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("The public app URL must use https");
  }
  return url.origin;
}

async function assertEmptyTarget(target: string): Promise<void> {
  try {
    const entries = await readdir(target);
    if (entries.length > 0) {
      throw new Error(`Target directory is not empty: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(target, { recursive: true });
  }
}

async function copyTemplate(target: string): Promise<void> {
  await cp(templateRoot, target, {
    recursive: true,
    filter(source) {
      return (
        !source.includes(`${join("apps", "cloud", "dist")}${join("", "")}`) &&
        !source.includes(
          `${join("apps", "cloud", ".wrangler")}${join("", "")}`,
        ) &&
        !source.includes(
          `${join("apps", "cloud", "node_modules")}${join("", "")}`,
        )
      );
    },
  });
}

async function configureProject(
  target: string,
  config: ProjectConfig,
): Promise<void> {
  const packagePath = join(target, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<
    string,
    unknown
  > & {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  packageJson.name = safeWorkerName(config.workerName);
  packageJson.private = true;
  if (packageJson.dependencies?.flary === "workspace:*") {
    packageJson.dependencies.flary = "^0.2.12";
  }
  packageJson.scripts = {
    ...packageJson.scripts,
    "db:migrate:local": `wrangler d1 migrations apply ${config.databaseName} --local`,
    "db:migrate:remote": `wrangler d1 migrations apply ${config.databaseName} --remote --env production`,
    deploy: "vite build && wrangler deploy --env production",
  };
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const wranglerPath = join(target, "wrangler.jsonc");
  let wrangler = await readFile(wranglerPath, "utf8");
  wrangler = wrangler
    .replaceAll('"name": "flary-cloud-local"', `"name": "${config.workerName}"`)
    .replaceAll('"name": "flary-cloud"', `"name": "${config.workerName}"`)
    .replaceAll('"database_name": "flary-cloud-local"', `"database_name": "${config.databaseName}"`)
    .replaceAll('"database_name": "flary-cloud"', `"database_name": "${config.databaseName}"`)
    .replaceAll('"bucket_name": "flary-artifacts-local"', `"bucket_name": "${config.bucketName}"`)
    .replaceAll('"bucket_name": "flary-artifacts"', `"bucket_name": "${config.bucketName}"`)
    .replaceAll("https://flary.example.com", config.appUrl)
    .replaceAll("flary.example.com", new URL(config.appUrl).hostname)
    .replaceAll("noreply@flary.example.com", `noreply@${new URL(config.appUrl).hostname}`);
  if (config.databaseId) {
    wrangler = wrangler.replaceAll(
      "replace-with-d1-database-id",
      config.databaseId,
    );
  }

  const isWorkersDev = new URL(config.appUrl).hostname.endsWith(".workers.dev");
  if (isWorkersDev) {
    wrangler = wrangler.replace(
      /"routes": \[\{ "pattern": "[^"]+", "custom_domain": true \}\],/,
      '"workers_dev": true,',
    );
  }
  await writeFile(wranglerPath, wrangler);

  const readmePath = join(target, "README.md");
  const readme = await readFile(readmePath, "utf8");
  await writeFile(
    readmePath,
    `# ${config.name}\n\n${readme.replace(/^# Flary Cloud\n\n/, "")}`,
  );
}

async function writeLocalSecrets(target: string): Promise<{
  authSecret: string;
  encryptionKey: string;
}> {
  const authSecret = randomBytes(32).toString("base64url");
  const encryptionKey = randomBytes(32).toString("base64url");
  await writeFile(
    join(target, ".dev.vars"),
    [
      `BETTER_AUTH_SECRET=${authSecret}`,
      `FLARY_TOKEN_ENCRYPTION_KEY_B64=${encryptionKey}`,
      "",
    ].join("\n"),
    { flag: "wx" },
  );
  return { authSecret, encryptionKey };
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer | string) => {
    const value = String(chunk);
    stdout += value;
    if (options.stream) process.stdout.write(value);
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    const value = String(chunk);
    stderr += value;
    if (options.stream) process.stderr.write(value);
  });
  if (options.input !== undefined) child.stdin.write(options.input);
  child.stdin.end();

  const code = await new Promise<number>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolveCode(exitCode ?? 1));
  });
  return { code, stdout, stderr };
}

async function runRequired(
  command: string,
  args: readonly string[],
  options: CommandOptions,
  label: string,
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    const details = (result.stderr || result.stdout).trim().slice(-2000);
    throw new Error(`${label} failed${details ? `:\n${details}` : "."}`);
  }
  return result;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function parseJsonOutput<T>(value: string): T | null {
  const clean = stripAnsi(value).trim();
  try {
    return JSON.parse(clean) as T;
  } catch {
    // Wrangler can print status lines before --json output. Try each line as
    // a JSON document without printing the document to the terminal.
    const lines = clean.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const candidate = lines.slice(index).join("\n").trim();
      try {
        return JSON.parse(candidate) as T;
      } catch {
        // Continue until a JSON document is found.
      }
    }
  }
  return null;
}

function arrayResult(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  if (Array.isArray(value.result)) return value.result.filter(isRecord);
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function findStringByKey(value: unknown, keys: readonly string[]): string | null {
  if (!isRecord(value)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const result = findStringByKey(item, keys);
        if (result) return result;
      }
    }
    return null;
  }
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  for (const child of Object.values(value)) {
    const result = findStringByKey(child, keys);
    if (result) return result;
  }
  return null;
}

async function wrangler(
  target: string,
  args: readonly string[],
  options: Omit<CommandOptions, "cwd"> = {},
): Promise<CommandResult> {
  return runCommand(
    "pnpm",
    ["exec", "wrangler", ...args, "--config", "wrangler.jsonc"],
    { cwd: target, ...options },
  );
}

async function findD1Database(
  target: string,
  databaseName: string,
): Promise<string | null> {
  const result = await wrangler(target, ["d1", "list", "--json"]);
  if (result.code !== 0) return null;
  const rows = arrayResult(parseJsonOutput<unknown>(result.stdout));
  const row = rows.find((item) => item.name === databaseName);
  return row && typeof row.database_id === "string" ? row.database_id : null;
}

async function ensureD1Database(
  target: string,
  databaseName: string,
): Promise<string> {
  const existing = await findD1Database(target, databaseName);
  if (existing) {
    console.log(`Using existing D1 database ${databaseName}.`);
    return existing;
  }

  console.log(`Creating D1 database ${databaseName}…`);
  const created = await wrangler(target, ["d1", "create", databaseName, "--json"]);
  if (created.code === 0) {
    const databaseId = findStringByKey(
      parseJsonOutput<unknown>(created.stdout),
      ["database_id", "uuid"],
    );
    if (databaseId) return databaseId;
  }

  const afterCreate = await findD1Database(target, databaseName);
  if (afterCreate) return afterCreate;
  const details = (created.stderr || created.stdout).trim().slice(-2000);
  throw new Error(
    `Could not provision D1 database ${databaseName}${details ? `:\n${details}` : "."}`,
  );
}

async function findR2Bucket(
  target: string,
  bucketName: string,
): Promise<boolean> {
  const result = await wrangler(target, ["r2", "bucket", "list", "--json"]);
  if (result.code !== 0) return false;
  const rows = arrayResult(parseJsonOutput<unknown>(result.stdout));
  return rows.some((item) => item.name === bucketName);
}

async function ensureR2Bucket(target: string, bucketName: string): Promise<void> {
  if (await findR2Bucket(target, bucketName)) {
    console.log(`Using existing R2 bucket ${bucketName}.`);
    return;
  }
  console.log(`Creating R2 bucket ${bucketName}…`);
  const created = await wrangler(target, ["r2", "bucket", "create", bucketName]);
  if (created.code === 0 || (await findR2Bucket(target, bucketName))) return;
  const details = (created.stderr || created.stdout).trim().slice(-2000);
  throw new Error(
    `Could not provision R2 bucket ${bucketName}${details ? `:\n${details}` : "."}`,
  );
}

async function putSecret(
  target: string,
  name: string,
  value: string,
): Promise<void> {
  await runRequired(
    "pnpm",
    ["exec", "wrangler", "secret", "put", name, "--env", "production", "--config", "wrangler.jsonc"],
    { cwd: target, input: `${value}\n` },
    `Setting ${name}`,
  );
}

async function provisionProject(
  target: string,
  config: ProjectConfig,
  secrets: { authSecret: string; encryptionKey: string },
): Promise<void> {
  console.log("\nInstalling the generated project dependencies…");
  await runRequired("pnpm", ["install"], { cwd: target, stream: true }, "Installing dependencies");

  console.log("\nChecking the Cloudflare login…");
  await runRequired(
    "pnpm",
    ["exec", "wrangler", "whoami", "--config", "wrangler.jsonc"],
    { cwd: target, stream: true },
    "Cloudflare login check",
  );

  const databaseId = await ensureD1Database(target, config.databaseName);
  await ensureR2Bucket(target, config.bucketName);
  await configureProject(target, { ...config, databaseId });

  console.log("\nStoring production secrets…");
  await putSecret(target, "BETTER_AUTH_SECRET", secrets.authSecret);
  await putSecret(
    target,
    "FLARY_TOKEN_ENCRYPTION_KEY_B64",
    secrets.encryptionKey,
  );

  const oauthClientId = process.env.FLARY_CLOUDFLARE_OAUTH_CLIENT_ID?.trim();
  const oauthClientSecret = process.env.FLARY_CLOUDFLARE_OAUTH_CLIENT_SECRET?.trim();
  if (oauthClientId && oauthClientSecret) {
    await putSecret(target, "CLOUDFLARE_OAUTH_CLIENT_ID", oauthClientId);
    await putSecret(target, "CLOUDFLARE_OAUTH_CLIENT_SECRET", oauthClientSecret);
  } else {
    console.log(
      "Cloudflare OAuth is not configured yet. The browser onboarding will show the callback URL and scopes.",
    );
  }

  console.log("\nApplying the remote D1 migrations…");
  await runRequired(
    "pnpm",
    ["run", "db:migrate:remote"],
    { cwd: target, stream: true },
    "Applying D1 migrations",
  );

  console.log("\nDeploying the Worker, Durable Objects, assets, and Sandbox…");
  await runRequired(
    "pnpm",
    ["run", "deploy"],
    { cwd: target, stream: true },
    "Deploying Flary Cloud",
  );
}

function printNextSteps(
  target: string,
  config: ProjectConfig,
  provisioned: boolean,
): void {
  console.log(`\nCreated ${target}`);
  if (provisioned) {
    console.log(`\nFlary Cloud is live at ${config.appUrl}`);
    console.log("\nOpen the URL and complete this setup:");
    console.log("  1. Create your Flary user account.");
    console.log("  2. Create a workspace.");
    console.log("  3. Connect your Cloudflare account in the BYOK card.");
    console.log("  4. Create your first Flary app.");
    console.log("  5. Upload a prompt and call it through the Flary client.");
  } else {
    console.log("\nNext steps:");
    console.log(`  cd ${target}`);
    console.log("  pnpm install");
    console.log("  pnpm db:migrate:local");
    console.log("  pnpm dev");
    console.log("\nFor an automatic Cloudflare deployment, run:");
    console.log("  pnpm dlx create-flary --provision");
  }

  console.log("\nCloudflare OAuth setup:");
  console.log(
    `  Callback: ${config.appUrl}/api/cloudflare/oauth/callback`,
  );
  console.log(
    "  Scopes: account-settings.read memberships.read aig.read aig.run aig.write ai.read",
  );
  console.log(
    "  Set FLARY_CLOUDFLARE_OAUTH_CLIENT_ID and FLARY_CLOUDFLARE_OAUTH_CLIENT_SECRET before provisioning to store them automatically.",
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const defaultWorkerName = safeWorkerName(basename(parsed.target));
    const name = parsed.name ??
      (parsed.yes
        ? "My Flary workspace"
        : await ask(reader, "Workspace name", "My Flary workspace"));
    const workerName = safeWorkerName(
      parsed.workerName ??
        (parsed.yes
          ? defaultWorkerName
          : await ask(reader, "Cloudflare Worker name", defaultWorkerName)),
    );
    const appUrl = normalizeAppUrl(
      parsed.appUrl ??
        (parsed.yes
          ? `https://${workerName}.workers.dev`
          : await ask(reader, "Public app URL", `https://${workerName}.workers.dev`)),
    );
    const config: ProjectConfig = {
      name,
      workerName,
      appUrl,
      databaseName: resourceName(workerName, "db"),
      bucketName: resourceName(workerName, "artifacts"),
    };

    await assertEmptyTarget(parsed.target);
    await copyTemplate(parsed.target);
    await configureProject(parsed.target, config);
    const secrets = await writeLocalSecrets(parsed.target);

    if (parsed.provision) {
      await provisionProject(parsed.target, config, secrets);
    }
    printNextSteps(parsed.target, config, parsed.provision);
  } finally {
    reader.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

