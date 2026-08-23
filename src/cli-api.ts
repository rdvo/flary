import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prompts from "@clack/prompts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatesRoot = join(packageRoot, "templates");

type Template = "dashboard" | "backend";
export type Provider = "google" | "openai" | "anthropic" | "workers-ai" | "none";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
type Feature = "browser" | "sandbox" | "mcp";

type PackageManifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export interface FlaryProjectState {
  readonly version: 1;
  readonly template: Template;
  readonly provider: Provider;
  readonly model?: string;
  readonly widget?: boolean;
  readonly features: readonly Feature[];
  readonly packageManager: PackageManager;
  readonly workerName: string;
  readonly profile?: string;
  readonly accountId?: string;
  readonly deployedUrl?: string;
  readonly requiredSecrets: readonly string[];
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly quiet?: boolean;
  }): Promise<CommandResult>;
}

export interface RunFlaryCliOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly runner?: CommandRunner;
  readonly log?: (message: string) => void;
  readonly prompt?: CliPrompt;
}

export interface CliPrompt {
  intro(message: string): void;
  select(options: Record<string, unknown>): Promise<unknown>;
  multiselect(options: Record<string, unknown>): Promise<unknown>;
  confirm(options: Record<string, unknown>): Promise<unknown>;
  password(options: Record<string, unknown>): Promise<unknown>;
  isCancel(value: unknown): boolean;
  cancel(message: string): void;
}

interface ParsedArgs {
  readonly command?: string;
  readonly target?: string;
  readonly template?: Template;
  readonly provider?: Provider;
  readonly model?: string;
  readonly features?: readonly Feature[];
  readonly profile?: string;
  readonly account?: string;
  readonly packageManager?: PackageManager;
  readonly deploy?: boolean;
  readonly yes: boolean;
  readonly hasNewFlags: boolean;
}

interface SetupAnswers {
  readonly template: Template;
  readonly provider: Provider;
  readonly model?: string;
  readonly features: readonly Feature[];
  readonly packageManager: PackageManager;
  readonly deploy: boolean;
  readonly authMode: "personal" | "existing";
  readonly secrets: Record<string, string>;
}

const appSource = `import { flary, z } from "flary";

export const app = flary({
  model: "openai/gpt-5",
  bindings: z.object({ APP_ENV: z.string().default("development") }),
});
`;

const toolsSource = `import { z } from "flary";
import { app } from "./flary";

export const searchDocs = app.fn({
  description: "Search product documentation",
  input: z.object({ query: z.string().min(1) }),
  output: z.array(z.object({ title: z.string(), url: z.string().url() })),
  run: ({ query }) => [{ title: query, url: "https://example.com/docs" }],
});

export const tools = app.tools({ searchDocs });
`;

const supportSource = `import { z } from "flary";
import { app } from "./flary";
import { tools } from "./tools";

export const support = app.fn({
  input: z.object({ question: z.string().min(1) }),
  output: z.object({ answer: z.string() }),
  tools,
  prompt: ({ question }) => question,
});
`;

const defaultRunner: CommandRunner = {
  run(command, args, options) {
    return new Promise((resolveResult, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: options.quiet ? ["ignore", "pipe", "pipe"] : ["inherit", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (!options.quiet) process.stdout.write(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (!options.quiet) process.stderr.write(chunk);
      });
      child.once("error", reject);
      child.once("close", (code) => resolveResult({
        code: code ?? 1,
        stdout,
        stderr,
      }));
    });
  },
};

const defaultPrompt: CliPrompt = {
  intro: prompts.intro,
  select: (options) => prompts.select(options as never),
  multiselect: (options) => prompts.multiselect(options as never),
  confirm: (options) => prompts.confirm(options as never),
  password: (options) => prompts.password(options as never),
  isCancel: prompts.isCancel,
  cancel: prompts.cancel,
};

function printHelp(log: (message: string) => void): void {
  log(`Flary

Usage:
  flary create [directory]   Create and optionally deploy a Flary project
  flary quickstart [directory] Open the local setup assistant
  flary setup [directory]    Resume setup or change provider and features
  flary deploy [directory]   Build, provision, deploy, and verify
  flary doctor [directory]   Check the local and deployed configuration
  flary init [directory]     Add typed Flary files to an existing project
  flary help                 Show this help

Setup options:
  --template dashboard|backend
  --provider google|openai|anthropic|workers-ai|none
  --model <exact-provider-model>
  --features browser,sandbox,mcp
  --profile <wrangler-profile>
  --account <cloudflare-account-id>
  --package-manager npm|pnpm|yarn|bun
  --deploy | --no-deploy
  --yes

Examples:
  flary create
  flary create my-agent --template backend --provider workers-ai --package-manager npm --deploy --yes
  flary doctor
`);
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const [command, ...rest] = args;
  let target: string | undefined;
  let template: Template | undefined;
  let provider: Provider | undefined;
  let model: string | undefined;
  let features: Feature[] | undefined;
  let profile: string | undefined;
  let account: string | undefined;
  let packageManager: PackageManager | undefined;
  let deploy: boolean | undefined;
  let yes = false;
  let hasNewFlags = false;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]!;
    if (!value.startsWith("-")) {
      if (target) throw new Error(`Unexpected argument: ${value}`);
      target = value;
      continue;
    }
    hasNewFlags = true;
    const take = () => {
      const next = rest[++index];
      if (!next || next.startsWith("-")) throw new Error(`Missing value for ${value}`);
      return next;
    };
    if (value === "--template") template = parseChoice<Template>(take(), ["dashboard", "backend"], value);
    else if (value === "--provider") provider = parseChoice<Provider>(take(), ["google", "openai", "anthropic", "workers-ai", "none"], value);
    else if (value === "--model") model = take();
    else if (value === "--features") {
      const raw = take();
      features = raw === "" ? [] : raw.split(",").map((entry) => parseChoice<Feature>(entry, ["browser", "sandbox", "mcp"], value));
    } else if (value === "--profile") profile = take();
    else if (value === "--account") account = take();
    else if (value === "--package-manager") packageManager = parseChoice<PackageManager>(take(), ["npm", "pnpm", "yarn", "bun"], value);
    else if (value === "--deploy") deploy = true;
    else if (value === "--no-deploy") deploy = false;
    else if (value === "--yes" || value === "-y") yes = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  return { command, target, template, provider, model, features, profile, account, packageManager, deploy, yes, hasNewFlags };
}

function parseChoice<T extends string>(value: string, choices: readonly T[], flag: string): T {
  if (!choices.includes(value as T)) {
    throw new Error(`Invalid value for ${flag}: ${value}. Use ${choices.join(", ")}.`);
  }
  return value as T;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, "utf8")) as PackageManifest;
}

async function packageVersion(): Promise<string> {
  const manifest = await readManifest(join(packageRoot, "package.json"));
  return manifest.version ?? "latest";
}

function packageCommands(manager: PackageManager): { install: [string, string[]]; dev: string } {
  if (manager === "pnpm") return { install: ["pnpm", ["install"]], dev: "pnpm dev" };
  if (manager === "yarn") return { install: ["yarn", []], dev: "yarn dev" };
  if (manager === "bun") return { install: ["bun", ["install"]], dev: "bun run dev" };
  return { install: ["npm", ["install"]], dev: "npm run dev" };
}

function workerName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "flary-agent";
}

function requiredSecrets(
  template: Template,
  provider: Provider,
  authMode: "personal" | "existing",
  features: readonly Feature[] = [],
): string[] {
  const values = ["FLARY_INTERNAL_TOKEN", "FLARY_SESSION_ARCHIVE_KEY"];
  if (template === "dashboard") {
    values.push("BETTER_AUTH_SECRET", "FLARY_TOKEN_ENCRYPTION_KEY_B64", "FLARY_SETUP_TOKEN");
  } else if (authMode === "personal") {
    values.push("FLARY_ACCESS_TOKEN");
  }
  if (provider === "openai") values.push("OPENAI_API_KEY");
  if (provider === "anthropic") values.push("ANTHROPIC_API_KEY");
  if (provider === "google") values.push("GEMINI_API_KEY");
  if (template === "backend" && features.includes("mcp")) values.push("GITHUB_MCP_PAT");
  return values;
}

function normalizeFeatures(template: Template, features: readonly Feature[]): Feature[] {
  return template === "dashboard"
    ? [...new Set<Feature>(["mcp", ...features])]
    : [...new Set(features)];
}

function randomSecret(bytes = 32): string {
  return crypto.getRandomValues(new Uint8Array(bytes)).reduce((value, byte) => value + byte.toString(16).padStart(2, "0"), "");
}

async function promptSetup(parsed: ParsedArgs, env: NodeJS.ProcessEnv, prompt: CliPrompt): Promise<SetupAnswers> {
  prompt.intro("Create your Flary deployment");
  const template = parsed.template ?? await prompt.select({
    message: "What do you want to deploy?",
    options: [
      { value: "dashboard", label: "Personal dashboard", hint: "Agents, threads, connections, and approvals" },
      { value: "backend", label: "Agent backend", hint: "Use it from your website, CMS, or bot" },
    ],
    initialValue: "dashboard",
  });
  cancelIfNeeded(template, prompt);
  const provider = parsed.provider ?? await prompt.select({
    message: "Which AI provider should work first?",
    options: [
      { value: "google", label: "Google Gemini API key", hint: "Recommended for the quick start" },
      { value: "openai", label: "OpenAI API key" },
      { value: "anthropic", label: "Anthropic API key" },
      { value: "workers-ai", label: "Cloudflare Workers AI", hint: "No provider key" },
      { value: "none", label: "Skip for now" },
    ],
    initialValue: "openai",
  });
  cancelIfNeeded(provider, prompt);
  const model = parsed.model ?? (provider === "google"
    ? await prompt.select({
        message: "Exact Gemini model",
        options: [
          { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
          { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
        ],
        initialValue: "gemini-2.5-flash",
      })
    : undefined);
  cancelIfNeeded(model, prompt);
  const packageManager = parsed.packageManager ?? await prompt.select({
    message: "Package manager",
    options: ["npm", "pnpm", "yarn", "bun"].map((value) => ({ value, label: value })),
    initialValue: "npm",
  });
  cancelIfNeeded(packageManager, prompt);
  const selectedFeatures = parsed.features ?? await prompt.multiselect({
    message: "Optional features",
    options: [
      ...(template === "backend" ? [{ value: "mcp", label: "GitHub MCP example" }] : []),
      { value: "browser", label: "Browser Run" },
      { value: "sandbox", label: "Sandbox", hint: "Requires Docker and a paid Workers plan" },
    ],
    required: false,
  });
  cancelIfNeeded(selectedFeatures, prompt);
  const features = normalizeFeatures(template as Template, selectedFeatures as Feature[]);
  const authMode = template === "backend"
    ? await prompt.select({
        message: "How should the backend authenticate requests?",
        options: [
          { value: "personal", label: "Generated bearer token" },
          { value: "existing", label: "My application identity", hint: "Fails closed until you add the resolver" },
        ],
        initialValue: "personal",
      })
    : "personal";
  cancelIfNeeded(authMode, prompt);
  const deploy = parsed.deploy ?? await prompt.confirm({ message: "Install and deploy now?", initialValue: true });
  cancelIfNeeded(deploy, prompt);
  const secrets: Record<string, string> = {};
  if (provider === "openai") {
    const value = env.OPENAI_API_KEY ?? await prompt.password({ message: "OpenAI API key", validate: requiredValue });
    cancelIfNeeded(value, prompt);
    secrets.OPENAI_API_KEY = String(value);
  } else if (provider === "anthropic") {
    const value = env.ANTHROPIC_API_KEY ?? await prompt.password({ message: "Anthropic API key", validate: requiredValue });
    cancelIfNeeded(value, prompt);
    secrets.ANTHROPIC_API_KEY = String(value);
  } else if (provider === "google") {
    const value = env.GEMINI_API_KEY ?? env.GOOGLE_GENERATIVE_AI_API_KEY ?? await prompt.password({ message: "Google Gemini API key", validate: requiredValue });
    cancelIfNeeded(value, prompt);
    secrets.GEMINI_API_KEY = String(value);
  }
  if (template === "backend" && features.includes("mcp")) {
    const value = env.GITHUB_MCP_PAT ?? await prompt.password({ message: "GitHub token for the read-only MCP example", validate: requiredValue });
    cancelIfNeeded(value, prompt);
    secrets.GITHUB_MCP_PAT = String(value);
  }
  return {
    template: template as Template,
    provider: provider as Provider,
    ...(model ? { model: String(model) } : {}),
    packageManager: packageManager as PackageManager,
    features,
    authMode: authMode as "personal" | "existing",
    deploy: Boolean(deploy),
    secrets,
  };
}

function requiredValue(value: string | undefined): string | undefined {
  return value?.trim() ? undefined : "This value is required.";
}

function cancelIfNeeded(value: unknown, prompt: CliPrompt): void {
  if (prompt.isCancel(value)) {
    prompt.cancel("Setup stopped. Run `flary setup` to continue.");
    throw new Error("Setup cancelled");
  }
}

async function scaffoldProject(target: string, answers: SetupAnswers, parsed: ParsedArgs): Promise<FlaryProjectState> {
  if (await exists(target)) {
    const entries = await readdir(target);
    if (entries.length > 0) throw new Error(`Target directory is not empty: ${target}`);
  } else {
    await mkdir(target, { recursive: true });
  }
  const source = join(templatesRoot, answers.template === "backend" ? "starter" : "dashboard");
  if (!(await exists(source))) throw new Error(`The ${answers.template} template is not included in this Flary package.`);
  await cp(source, target, { recursive: true });
  if (await exists(join(target, "gitignore"))) await rename(join(target, "gitignore"), join(target, ".gitignore"));
  const name = workerName(basename(target));
  const manifestPath = join(target, "package.json");
  const manifest = await readManifest(manifestPath);
  manifest.name = name;
  manifest.dependencies = { ...manifest.dependencies, flary: await packageVersion() };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const generatedSecrets = generatedSecretValues(answers.template, answers.authMode);
  const allSecrets = { ...generatedSecrets, ...answers.secrets };
  await writeDevVars(target, allSecrets);
  const state: FlaryProjectState = {
    version: 1,
    template: answers.template,
    provider: answers.provider,
    ...(answers.model ? { model: answers.model } : {}),
    features: answers.features,
    packageManager: answers.packageManager,
    workerName: name,
    ...(parsed.profile ? { profile: parsed.profile } : {}),
    ...(parsed.account ? { accountId: parsed.account } : {}),
    requiredSecrets: requiredSecrets(answers.template, answers.provider, answers.authMode, answers.features),
  };
  await updateWrangler(target, { name, accountId: parsed.account, requiredSecrets: state.requiredSecrets, workersAI: state.provider === "workers-ai" });
  await writeProjectState(target, state);
  await writeGeneratedOptions(target, state, answers.authMode);
  return state;
}

function generatedSecretValues(template: Template, authMode: "personal" | "existing"): Record<string, string> {
  const values: Record<string, string> = {
    FLARY_INTERNAL_TOKEN: randomSecret(),
    FLARY_SESSION_ARCHIVE_KEY: randomSecret(),
  };
  if (template === "dashboard") {
    values.BETTER_AUTH_SECRET = randomSecret();
    values.FLARY_TOKEN_ENCRYPTION_KEY_B64 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    values.FLARY_SETUP_TOKEN = randomSecret(24);
  } else if (authMode === "personal") {
    values.FLARY_ACCESS_TOKEN = randomSecret(24);
  }
  return values;
}

async function writeGeneratedOptions(target: string, state: FlaryProjectState, authMode: "personal" | "existing"): Promise<void> {
  const model = state.model ?? (state.provider === "google" ? "gemini-2.5-flash" : state.provider === "anthropic" ? "claude-sonnet-4-5" : state.provider === "workers-ai" ? "@cf/meta/llama-3.3-70b-instruct-fp8-fast" : "gpt-5");
  const modelPrefix = state.provider === "workers-ai" ? "cloudflare" : state.provider;
  const qualifiedModel = state.provider !== "none" && !model.startsWith(`${modelPrefix}/`) ? `${modelPrefix}/${model}` : model;
  const features = {
    mcp: state.features.includes("mcp"),
    browser: state.features.includes("browser"),
    sandbox: state.features.includes("sandbox"),
  };
  const source = [
    "// Generated by `flary setup`. You can rerun setup safely.",
    "type GeneratedConfig = {",
    "  readonly model: string;",
    "  readonly provider: \"google\" | \"openai\" | \"anthropic\" | \"workers-ai\" | \"none\";",
    "  readonly features: { readonly mcp: boolean; readonly browser: boolean; readonly sandbox: boolean };",
    "  readonly authMode: \"personal\" | \"existing\";",
    "  readonly widget: boolean;",
    "};",
    `export const generated: GeneratedConfig = ${JSON.stringify({ model: qualifiedModel, provider: state.provider, features, authMode, widget: Boolean(state.widget) }, null, 2)};`,
    "",
  ].join("\n");
  await writeFile(join(target, "src", "flary.generated.ts"), source);
}

async function writeDevVars(target: string, values: Record<string, string>): Promise<void> {
  const file = join(target, ".dev.vars");
  const current = await readKeyValueFile(file);
  const merged = { ...current, ...values };
  await writeFile(file, Object.entries(merged).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n", { mode: 0o600 });
  await chmod(file, 0o600);
}

async function readKeyValueFile(file: string): Promise<Record<string, string>> {
  if (!(await exists(file))) return {};
  const values: Record<string, string> = {};
  for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    try { values[match[1]!] = JSON.parse(match[2]!); } catch { values[match[1]!] = match[2]!; }
  }
  return values;
}

async function writeProjectState(target: string, state: FlaryProjectState): Promise<void> {
  await mkdir(join(target, ".flary"), { recursive: true });
  await writeFile(join(target, ".flary", "project.json"), `${JSON.stringify(state, null, 2)}\n`);
}

async function readProjectState(target: string): Promise<FlaryProjectState> {
  const file = join(target, ".flary", "project.json");
  if (!(await exists(file))) throw new Error(`No Flary setup state was found in ${target}. Run \`flary create\` first.`);
  return JSON.parse(await readFile(file, "utf8")) as FlaryProjectState;
}

async function readOrRecoverProjectState(target: string): Promise<FlaryProjectState> {
  try {
    return await readProjectState(target);
  } catch {
    const generatedFile = join(target, "src", "flary.generated.ts");
    const manifestFile = join(target, "package.json");
    if (!(await exists(generatedFile)) || !(await exists(manifestFile))) {
      throw new Error(`Setup cannot resume because ${target} is not a generated Flary project.`);
    }
    const source = await readFile(generatedFile, "utf8");
    const provider = /["']?provider["']?\s*:\s*["']([^"']+)/.exec(source)?.[1] as Provider | undefined;
    const model = /["']?model["']?\s*:\s*["']([^"']+)/.exec(source)?.[1];
    const widget = /["']?widget["']?\s*:\s*true/.test(source);
    const authMode = /["']?authMode["']?\s*:\s*["']([^"']+)/.exec(source)?.[1] === "personal" ? "personal" : "existing";
    if (!provider || !["google", "openai", "anthropic", "workers-ai", "none"].includes(provider)) {
      throw new Error("Setup cannot resume because the generated provider setting is invalid.");
    }
    const legacyFeatures = /["']?features["']?\s*:\s*(\[[^\]]*\])/.exec(source)?.[1];
    const featureObject = /["']?features["']?\s*:\s*(\{[^}]*\})/.exec(source)?.[1];
    const features = legacyFeatures
      ? [...legacyFeatures.matchAll(/["'](browser|sandbox|mcp)["']/g)].map((match) => match[1] as Feature)
      : (["mcp", "browser", "sandbox"] as const).filter((feature) =>
          new RegExp(`["']?${feature}["']?\\s*:\\s*true`).test(featureObject ?? ""));
    const template: Template = await exists(join(target, "migrations", "0001_dashboard.sql")) ? "dashboard" : "backend";
    const manifest = await readManifest(manifestFile);
    const packageManager: PackageManager = await exists(join(target, "pnpm-lock.yaml"))
      ? "pnpm" : await exists(join(target, "yarn.lock"))
        ? "yarn" : await exists(join(target, "bun.lock")) || await exists(join(target, "bun.lockb"))
          ? "bun" : "npm";
    const wrangler = JSON.parse(await readFile(join(target, "wrangler.jsonc"), "utf8")) as Record<string, unknown>;
    const state: FlaryProjectState = {
      version: 1,
      template,
      provider,
      ...(model ? { model } : {}),
      ...(widget ? { widget: true } : {}),
      features,
      packageManager,
      workerName: typeof wrangler.name === "string" ? wrangler.name : workerName(manifest.name ?? basename(target)),
      ...(typeof wrangler.account_id === "string" ? { accountId: wrangler.account_id } : {}),
      requiredSecrets: requiredSecrets(template, provider, authMode, features),
    };
    await writeProjectState(target, state);
    return state;
  }
}

async function updateWrangler(target: string, input: { name?: string; accountId?: string; requiredSecrets?: readonly string[]; workersAI?: boolean }): Promise<void> {
  const file = join(target, "wrangler.jsonc");
  if (!(await exists(file))) return;
  const value = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  if (input.name) value.name = input.name;
  if (input.accountId) value.account_id = input.accountId;
  if (input.requiredSecrets) {
    const current = value.secrets && typeof value.secrets === "object" ? value.secrets as Record<string, unknown> : {};
    value.secrets = { ...current, required: [...new Set(input.requiredSecrets)] };
  }
  if (input.workersAI) value.ai = { binding: "AI" };
  else if (input.workersAI === false) delete value.ai;
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function installProject(target: string, state: FlaryProjectState, runner: CommandRunner, env: NodeJS.ProcessEnv): Promise<void> {
  const [command, args] = packageCommands(state.packageManager).install;
  const result = await runner.run(command, args, { cwd: target, env });
  if (result.code !== 0) throw new Error(`${command} install failed.`);
}

function localWrangler(target: string, state: FlaryProjectState): [string, string[]] {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const executable = join(target, "node_modules", ".bin", `wrangler${suffix}`);
  return [executable, state.profile ? ["--profile", state.profile] : []];
}

async function authenticateWrangler(target: string, state: FlaryProjectState, runner: CommandRunner, env: NodeJS.ProcessEnv, prompt: CliPrompt, requestedAccount?: string): Promise<FlaryProjectState> {
  const [wrangler, prefix] = localWrangler(target, state);
  let result = await runner.run(wrangler, [...prefix, "whoami", "--json"], { cwd: target, env, quiet: true });
  if (result.code !== 0) {
    let login = await runner.run(wrangler, [...prefix, "login", "--use-keyring"], { cwd: target, env, quiet: true });
    if (
      login.code !== 0 &&
      /use-keyring|unknown (argument|option)/i.test(`${login.stdout}\n${login.stderr}`)
    ) {
      // Some Wrangler releases use the operating-system credential store by
      // default and do not expose this flag.
      login = await runner.run(wrangler, [...prefix, "login"], { cwd: target, env });
    }
    if (login.code !== 0) throw new Error("Wrangler login failed.");
    result = await runner.run(wrangler, [...prefix, "whoami", "--json"], { cwd: target, env, quiet: true });
  }
  if (result.code !== 0) throw new Error("Wrangler authentication could not be verified.");
  const accounts = parseWranglerAccounts(result.stdout);
  let accountId = requestedAccount ?? state.accountId;
  if (!accountId && accounts.length === 1) accountId = accounts[0]!.id;
  if (!accountId && accounts.length > 1) {
    const selected = await prompt.select({ message: "Cloudflare account", options: accounts.map((account) => ({ value: account.id, label: account.name })) });
    cancelIfNeeded(selected, prompt);
    accountId = String(selected);
  }
  if (!accountId) throw new Error("No Cloudflare account is available. Use --account with an account ID.");
  if (accounts.length > 0 && !accounts.some((account) => account.id === accountId)) throw new Error(`Wrangler cannot access Cloudflare account ${accountId}.`);
  const next = { ...state, accountId };
  await updateWrangler(target, { accountId });
  await writeProjectState(target, next);
  return next;
}

export function parseWranglerAccounts(output: string): Array<{ id: string; name: string }> {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new Error("Wrangler returned invalid account data."); }
  const root = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const source = Array.isArray(root.accounts)
    ? root.accounts
    : Array.isArray(root.account)
      ? root.account
      : root.account && typeof root.account === "object"
        ? [root.account]
        : [];
  return source.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const account = value as Record<string, unknown>;
    const id = typeof account.id === "string" ? account.id : typeof account.account_id === "string" ? account.account_id : undefined;
    if (!id) return [];
    return [{ id, name: typeof account.name === "string" ? account.name : id }];
  });
}

async function deployProject(target: string, input: { runner: CommandRunner; env: NodeJS.ProcessEnv; prompt: CliPrompt; account?: string; log: (message: string) => void }): Promise<FlaryProjectState> {
  let state = await readProjectState(target);
  if (!(await exists(join(target, "node_modules")))) await installProject(target, state, input.runner, input.env);
  if (state.features.includes("sandbox")) await checkDocker(target, input.runner, input.env);
  state = await authenticateWrangler(target, state, input.runner, input.env, input.prompt, input.account);
  const build = await input.runner.run(state.packageManager, ["run", "build"], { cwd: target, env: input.env });
  if (build.code !== 0) throw new Error("The project build failed.");
  const localSecrets = await readKeyValueFile(join(target, ".dev.vars"));
  const missing = state.requiredSecrets.filter((name) => !localSecrets[name] && !input.env[name]);
  if (missing.length > 0) throw new Error(`Required secrets are missing: ${missing.join(", ")}. Run \`flary setup\`.`);
  const selectedSecrets = Object.fromEntries(state.requiredSecrets.map((name) => [name, localSecrets[name] ?? input.env[name]!])) as Record<string, string>;
  const secretDir = await mkdtemp(join(tmpdir(), "flary-secrets-"));
  const secretFile = join(secretDir, "secrets.json");
  const deploymentOutputFile = join(secretDir, "wrangler-output.ndjson");
  try {
    await writeFile(secretFile, JSON.stringify(selectedSecrets), { mode: 0o600 });
    await chmod(secretFile, 0o600);
    const [wrangler, prefix] = localWrangler(target, state);
    const deployed = await input.runner.run(wrangler, [...prefix, "deploy", "--secrets-file", secretFile], {
      cwd: target,
      env: { ...input.env, WRANGLER_OUTPUT_FILE_PATH: deploymentOutputFile },
    });
    if (deployed.code !== 0) throw new Error("Wrangler deployment failed.");
    if (state.template === "dashboard") {
      const migration = await input.runner.run(wrangler, [...prefix, "d1", "migrations", "apply", "FLARY_DASHBOARD_DB", "--remote"], { cwd: target, env: input.env });
      if (migration.code !== 0) throw new Error("Dashboard database migration failed.");
    }
    const url = await deploymentUrl(
      deployed.stdout + "\n" + deployed.stderr,
      deploymentOutputFile,
    );
    const next = { ...state, deployedUrl: url };
    await writeProjectState(target, next);
    await verifyDeployment(next, selectedSecrets, input.log);
    return next;
  } finally {
    await rm(secretDir, { recursive: true, force: true });
  }
}

async function deploymentUrl(output: string, outputFile: string): Promise<string> {
  if (await exists(outputFile)) {
    const records = (await readFile(outputFile, "utf8")).split(/\r?\n/).filter(Boolean);
    for (const line of records.reverse()) {
      try {
        const record = JSON.parse(line) as { targets?: unknown };
        const target = Array.isArray(record.targets)
          ? record.targets.find((value): value is string => typeof value === "string" && value.startsWith("https://"))
          : undefined;
        if (target) return target.replace(/\/$/, "");
      } catch {
        // Use Wrangler's readable output when one structured line is invalid.
      }
    }
  }
  const textTarget = /https:\/\/[^\s]+\.workers\.dev/.exec(output)?.[0]?.replace(/[),.;]+$/, "");
  if (textTarget) return textTarget;
  throw new Error("Wrangler deployed the Worker but did not report its URL. Run `flary doctor` after you add the URL to .flary/project.json.");
}

async function verifyDeployment(state: FlaryProjectState, secrets: Record<string, string>, log: (message: string) => void): Promise<void> {
  if (!state.deployedUrl) return;
  const health = await fetch(new URL("/health", state.deployedUrl), { signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
  if (!health?.ok) throw new Error(`Deployment completed, but ${state.deployedUrl}/health did not pass.`);
  if (state.template === "dashboard") {
    const setup = await fetch(new URL("/api/setup/status", state.deployedUrl), { signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    if (!setup?.ok) throw new Error("The Worker is healthy, but the dashboard setup route did not pass.");
  }
  if (state.template === "backend" && secrets.FLARY_ACCESS_TOKEN) {
    const result = await fetch(new URL("/functions/support", state.deployedUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${secrets.FLARY_ACCESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ question: "Reply with OK." }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined);
    if (!result?.ok && state.provider !== "none") throw new Error("The authenticated example operation did not pass.");
  }
  log(`Verified ${state.deployedUrl}`);
}

async function checkDocker(target: string, runner: CommandRunner, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runner.run("docker", ["info"], { cwd: target, env, quiet: true }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (result.code !== 0) throw new Error("Sandbox needs a running Docker-compatible builder and a paid Cloudflare Workers plan. Disable Sandbox or start Docker.");
}

async function createProject(parsed: ParsedArgs, options: Required<Pick<RunFlaryCliOptions, "cwd" | "env" | "isTTY" | "runner" | "log" | "prompt">>): Promise<void> {
  const target = resolve(options.cwd, parsed.target ?? "flary-agent");
  const legacy = !options.isTTY && !parsed.hasNewFlags;
  let answers: SetupAnswers;
  if (legacy) {
    answers = { template: "backend", provider: "openai", features: [], packageManager: "npm", deploy: false, authMode: "existing", secrets: {} };
  } else if (options.isTTY && !parsed.yes) {
    answers = await promptSetup(parsed, options.env, options.prompt);
  } else {
    if (!parsed.template || !parsed.provider || !parsed.packageManager || parsed.deploy === undefined) {
      throw new Error("Non-interactive create requires --template, --provider, --package-manager, and --deploy or --no-deploy.");
    }
    const authMode = "personal" as const;
    const secrets: Record<string, string> = {};
    if (parsed.provider === "openai") {
      if (!options.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for --provider openai in non-interactive mode.");
      secrets.OPENAI_API_KEY = options.env.OPENAI_API_KEY;
    }
    if (parsed.provider === "anthropic") {
      if (!options.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required for --provider anthropic in non-interactive mode.");
      secrets.ANTHROPIC_API_KEY = options.env.ANTHROPIC_API_KEY;
    }
    if (parsed.provider === "google") {
      const value = options.env.GEMINI_API_KEY ?? options.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!value) throw new Error("GEMINI_API_KEY is required for --provider google in non-interactive mode.");
      secrets.GEMINI_API_KEY = value;
    }
    const features = normalizeFeatures(parsed.template, parsed.features ?? []);
    if (parsed.template === "backend" && features.includes("mcp")) {
      if (!options.env.GITHUB_MCP_PAT) throw new Error("GITHUB_MCP_PAT is required when the MCP example is enabled in non-interactive mode.");
      secrets.GITHUB_MCP_PAT = options.env.GITHUB_MCP_PAT;
    }
    answers = { template: parsed.template, provider: parsed.provider, ...(parsed.model ? { model: parsed.model } : {}), features, packageManager: parsed.packageManager, deploy: parsed.deploy, authMode, secrets };
  }
  let state = await scaffoldProject(target, answers, parsed);
  options.log(`Created ${target}`);
  if (legacy) {
    options.log(`\nNext steps:\n  cd ${target}\n  npm install\n  npm run dev`);
    return;
  }
  await installProject(target, state, options.runner, options.env);
  if (answers.deploy) state = await deployProject(target, { runner: options.runner, env: options.env, prompt: options.prompt, account: parsed.account, log: options.log });
  const commands = packageCommands(state.packageManager);
  options.log(`\n${answers.deploy ? "Deployment ready" : "Project ready"}: ${target}`);
  if (state.deployedUrl) options.log(`Open: ${state.deployedUrl}${state.template === "dashboard" ? "/setup" : ""}`);
  if (state.template === "dashboard") options.log("First-owner token: .dev.vars → FLARY_SETUP_TOKEN");
  else if (answers.authMode === "personal") options.log("API bearer token: .dev.vars → FLARY_ACCESS_TOKEN");
  options.log(`Local development: cd ${target} && ${commands.dev}`);
  if (state.template === "dashboard") options.log(`Connections: ${state.deployedUrl ? `${state.deployedUrl}/connections` : "/connections"}`);
  options.log("Recovery: npx flary setup");
}

async function setupProject(target: string, parsed: ParsedArgs, options: Required<Pick<RunFlaryCliOptions, "env" | "isTTY" | "log" | "prompt">>): Promise<void> {
  const current = await readOrRecoverProjectState(target);
  const localSecrets = await readKeyValueFile(join(target, ".dev.vars"));
  let provider = parsed.provider ?? current.provider;
  let features = parsed.features ?? current.features;
  if (options.isTTY && !parsed.provider) {
    const selected = await options.prompt.select({ message: "AI provider", options: ["google", "openai", "anthropic", "workers-ai", "none"].map((value) => ({ value, label: value })) , initialValue: current.provider });
    cancelIfNeeded(selected, options.prompt);
    provider = selected as Provider;
  }
  if (options.isTTY && !parsed.features) {
    const selected = await options.prompt.multiselect({ message: "Optional features", options: ["mcp", "browser", "sandbox"].map((value) => ({ value, label: value })), initialValues: [...current.features], required: false });
    cancelIfNeeded(selected, options.prompt);
    features = selected as Feature[];
  }
  features = normalizeFeatures(current.template, features);
  const secrets: Record<string, string> = {};
  if (provider === "openai") {
    const value = options.env.OPENAI_API_KEY ?? localSecrets.OPENAI_API_KEY ?? (options.isTTY
      ? await options.prompt.password({ message: "OpenAI API key", validate: requiredValue })
      : undefined);
    cancelIfNeeded(value, options.prompt);
    if (!value) throw new Error("OPENAI_API_KEY is required. Set it in the environment or run setup in a terminal.");
    secrets.OPENAI_API_KEY = String(value);
  }
  if (provider === "anthropic") {
    const value = options.env.ANTHROPIC_API_KEY ?? localSecrets.ANTHROPIC_API_KEY ?? (options.isTTY
      ? await options.prompt.password({ message: "Anthropic API key", validate: requiredValue })
      : undefined);
    cancelIfNeeded(value, options.prompt);
    if (!value) throw new Error("ANTHROPIC_API_KEY is required. Set it in the environment or run setup in a terminal.");
    secrets.ANTHROPIC_API_KEY = String(value);
  }
  if (provider === "google") {
    const value = options.env.GEMINI_API_KEY ?? options.env.GOOGLE_GENERATIVE_AI_API_KEY ?? localSecrets.GEMINI_API_KEY ?? (options.isTTY
      ? await options.prompt.password({ message: "Google Gemini API key", validate: requiredValue })
      : undefined);
    cancelIfNeeded(value, options.prompt);
    if (!value) throw new Error("GEMINI_API_KEY is required. Set it in the environment or run setup in a terminal.");
    secrets.GEMINI_API_KEY = String(value);
  }
  if (current.template === "backend" && features.includes("mcp")) {
    const value = options.env.GITHUB_MCP_PAT ?? localSecrets.GITHUB_MCP_PAT ?? (options.isTTY
      ? await options.prompt.password({ message: "GitHub token for the read-only MCP example", validate: requiredValue })
      : undefined);
    cancelIfNeeded(value, options.prompt);
    if (!value) throw new Error("GITHUB_MCP_PAT is required while the MCP example is enabled. Set it in the environment or run setup in a terminal.");
    secrets.GITHUB_MCP_PAT = String(value);
  }
  if (Object.keys(secrets).length > 0) await writeDevVars(target, secrets);
  const authMode = current.requiredSecrets.includes("FLARY_ACCESS_TOKEN") ? "personal" : "existing";
  const next: FlaryProjectState = { ...current, provider, model: parsed.model ?? (provider === current.provider ? current.model : undefined), features, requiredSecrets: requiredSecrets(current.template, provider, authMode, features) };
  await writeGeneratedOptions(target, next, authMode);
  await updateWrangler(target, { requiredSecrets: next.requiredSecrets, workersAI: provider === "workers-ai" });
  await writeProjectState(target, next);
  options.log("Flary setup is ready. Run `npx flary deploy` to apply it.");
}

async function doctorProject(target: string, options: Required<Pick<RunFlaryCliOptions, "env" | "runner" | "log">>): Promise<void> {
  const checks: Array<[string, boolean, string]> = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(["Node 22.19 or newer", major >= 22, process.version]);
  let state: FlaryProjectState | undefined;
  try { state = await readProjectState(target); checks.push(["Flary project state", true, ".flary/project.json"]); } catch { checks.push(["Flary project state", false, "run `flary create`"]); }
  checks.push(["Generated Wrangler source", await exists(join(target, "wrangler.jsonc")), "wrangler.jsonc"]);
  if (state) {
    const packageManager = await options.runner.run(state.packageManager, ["--version"], { cwd: target, env: options.env, quiet: true }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    checks.push(["Package manager", packageManager.code === 0, state.packageManager]);
    checks.push(["Cloudflare account", Boolean(state.accountId), state.accountId ?? "run `flary deploy` to select an account"]);
    const values = await readKeyValueFile(join(target, ".dev.vars"));
    const missing = state.requiredSecrets.filter((name) => !values[name] && !options.env[name]);
    checks.push(["Required local secrets", missing.length === 0, missing.length ? missing.join(", ") : `${state.requiredSecrets.length} present`]);
    if (await exists(join(target, "node_modules"))) {
      const [wrangler, prefix] = localWrangler(target, state);
      const identity = await options.runner.run(wrangler, [...prefix, "whoami", "--json"], { cwd: target, env: options.env, quiet: true });
      checks.push(["Wrangler authentication", identity.code === 0, identity.code === 0 ? "authenticated" : "run `npx wrangler login`"]);
      const generated = [join(target, "dist", "flary.wrangler.json"), join(target, ".flue-vite.wrangler.jsonc")];
      const generatedFile = (await Promise.all(generated.map(async (file) => ({ file, present: await exists(file) })))).find(({ present }) => present)?.file;
      checks.push(["Generated runtime configuration", Boolean(generatedFile), generatedFile ?? "run the build if missing"]);
      if (generatedFile) {
        const problems = doctorBindingProblems(JSON.parse(await readFile(generatedFile, "utf8")) as Record<string, unknown>, state);
        checks.push(["Generated Cloudflare bindings", problems.length === 0, problems.length === 0 ? "complete" : `missing ${problems.join(", ")}`]);
      }
      if (state.features.includes("sandbox")) {
        const docker = await options.runner.run("docker", ["info"], { cwd: target, env: options.env, quiet: true }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
        checks.push(["Sandbox builder", docker.code === 0, docker.code === 0 ? "Docker is ready" : "start a Docker-compatible builder"]);
      }
    } else checks.push(["Dependencies", false, "run your package manager install command"]);
    if (state.template === "dashboard") {
      checks.push(["Dashboard migration", await exists(join(target, "migrations", "0001_dashboard.sql")), "migrations/0001_dashboard.sql"]);
    }
    if (state.deployedUrl) {
      const health = await fetch(new URL("/health", state.deployedUrl), { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      checks.push(["Deployed health", Boolean(health?.ok), state.deployedUrl]);
    }
  }
  for (const [name, ok, detail] of checks) options.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (checks.some(([, ok]) => !ok)) throw new Error("Flary doctor found a problem.");
}

function doctorBindingProblems(config: Record<string, unknown>, state: FlaryProjectState): string[] {
  const objects = config.durable_objects && typeof config.durable_objects === "object"
    ? config.durable_objects as { bindings?: Array<{ name?: unknown }> }
    : {};
  const names = new Set((objects.bindings ?? []).flatMap((binding) => typeof binding.name === "string" ? [binding.name] : []));
  const d1 = new Set((Array.isArray(config.d1_databases) ? config.d1_databases : []).flatMap((binding) =>
    binding && typeof binding === "object" && typeof (binding as { binding?: unknown }).binding === "string"
      ? [(binding as { binding: string }).binding]
      : []));
  const r2 = new Set((Array.isArray(config.r2_buckets) ? config.r2_buckets : []).flatMap((binding) =>
    binding && typeof binding === "object" && typeof (binding as { binding?: unknown }).binding === "string"
      ? [(binding as { binding: string }).binding]
      : []));
  const queues = config.queues && typeof config.queues === "object"
    ? config.queues as { producers?: Array<{ binding?: unknown }> }
    : {};
  const queueNames = new Set((queues.producers ?? []).flatMap((producer) => typeof producer.binding === "string" ? [producer.binding] : []));
  const missing: string[] = [];
  for (const binding of ["FLARY_RUN_SERVICE", "FLARY_THREAD_CONTROL", "FLARY_WORKSPACE"]) if (!names.has(binding)) missing.push(binding);
  for (const binding of ["FLARY_THREAD_CATALOG", ...(state.template === "dashboard" ? ["FLARY_DASHBOARD_DB"] : [])]) if (!d1.has(binding)) missing.push(binding);
  for (const binding of ["FLARY_SESSION_ARCHIVE", "WORKSPACE_BLOBS"]) if (!r2.has(binding)) missing.push(binding);
  if (!queueNames.has("FLARY_SESSION_PROJECTION_QUEUE")) missing.push("FLARY_SESSION_PROJECTION_QUEUE");
  if (state.features.includes("browser") && !(config.browser && typeof config.browser === "object")) missing.push("BROWSER");
  if (state.features.includes("sandbox") && !names.has("SANDBOX")) missing.push("SANDBOX");
  return missing;
}

async function writeIfMissing(path: string, content: string): Promise<"created" | "skipped"> {
  if (await exists(path)) return "skipped";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { flag: "wx" });
  return "created";
}

async function initProject(targetArg: string | undefined, cwd: string, log: (message: string) => void): Promise<void> {
  const target = resolve(cwd, targetArg ?? ".");
  const manifestPath = join(target, "package.json");
  if (!(await exists(manifestPath))) throw new Error(`No package.json was found in ${target}. Use "flary create" for a new project.`);
  const manifest = await readManifest(manifestPath);
  if (!manifest.dependencies?.flary && !manifest.devDependencies?.flary) {
    manifest.dependencies = { ...manifest.dependencies, flary: await packageVersion() };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const files = [
    { path: join(target, "src", "flary.ts"), content: appSource },
    { path: join(target, "src", "tools.ts"), content: toolsSource },
    { path: join(target, "src", "support.ts"), content: supportSource },
  ];
  const results = await Promise.all(files.map(async (file) => ({ path: file.path, status: await writeIfMissing(file.path, file.content) })));
  log(`Initialized Flary in ${target}`);
  for (const result of results) log(`  ${result.status === "created" ? "created" : "kept"} ${result.path}`);
}

export interface QuickstartProjectInput {
  readonly target: string;
  readonly workerName: string;
  readonly agentName: string;
  readonly systemPrompt: string;
  readonly provider: Provider;
  readonly model: string;
  readonly providerKey?: string;
  readonly accountId?: string;
  readonly packageManager?: PackageManager;
}

/** Create or update the generated widget project without exposing secret values. */
export async function prepareQuickstartProject(
  input: QuickstartProjectInput,
  options: Pick<RunFlaryCliOptions, "env" | "runner" | "log"> = {},
): Promise<FlaryProjectState> {
  const target = resolve(input.target);
  const env = options.env ?? process.env;
  const runner = options.runner ?? defaultRunner;
  const keyName = input.provider === "google"
    ? "GEMINI_API_KEY"
    : input.provider === "openai"
      ? "OPENAI_API_KEY"
      : input.provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : undefined;
  let state: FlaryProjectState;
  if (!(await exists(join(target, ".flary", "project.json")))) {
    const secrets = keyName && input.providerKey ? { [keyName]: input.providerKey } : {};
    state = await scaffoldProject(target, {
      template: "backend",
      provider: input.provider,
      model: input.model,
      features: [],
      packageManager: input.packageManager ?? "npm",
      deploy: false,
      authMode: "personal",
      secrets,
    }, {
      command: "create",
      target,
      template: "backend",
      provider: input.provider,
      model: input.model,
      features: [],
      packageManager: input.packageManager ?? "npm",
      deploy: false,
      yes: true,
      hasNewFlags: true,
      ...(input.accountId ? { account: input.accountId } : {}),
    });
    await installProject(target, state, runner, env);
  } else {
    state = await readProjectState(target);
    if (state.template !== "backend") throw new Error("The quick start needs a backend project directory.");
    if (keyName && input.providerKey) await writeDevVars(target, { [keyName]: input.providerKey });
  }
  const next: FlaryProjectState = {
    ...state,
    provider: input.provider,
    model: input.model,
    widget: true,
    workerName: workerName(input.workerName),
    ...(input.accountId ? { accountId: input.accountId } : {}),
    requiredSecrets: requiredSecrets("backend", input.provider, "personal", []),
  };
  await writeGeneratedOptions(target, next, "personal");
  await writeFile(join(target, "src", "assistant.generated.ts"), [
    "// Generated by the Flary quick start. Edit this file or run the setup again.",
    "export const assistantConfig = {",
    `  name: ${JSON.stringify(input.agentName)},`,
    `  systemPrompt: ${JSON.stringify(input.systemPrompt)},`,
    "} as const;",
    "",
  ].join("\n"));
  await updateWrangler(target, {
    name: next.workerName,
    accountId: next.accountId,
    requiredSecrets: next.requiredSecrets,
    workersAI: next.provider === "workers-ai",
  });
  await writeProjectState(target, next);
  options.log?.(`Prepared ${target}`);
  return next;
}

export async function deployQuickstartProject(
  target: string,
  input: { readonly accountId: string; readonly cloudflareAccessToken?: string },
  options: Pick<RunFlaryCliOptions, "env" | "runner" | "log"> = {},
): Promise<FlaryProjectState> {
  const env = {
    ...(options.env ?? process.env),
    ...(input.cloudflareAccessToken ? { CLOUDFLARE_API_TOKEN: input.cloudflareAccessToken } : {}),
  };
  return deployProject(resolve(target), {
    runner: options.runner ?? defaultRunner,
    env,
    account: input.accountId,
    prompt: defaultPrompt,
    log: options.log ?? (() => undefined),
  });
}

export async function runFlaryCli(args: readonly string[], options: RunFlaryCliOptions = {}): Promise<void> {
  const parsed = parseArgs(args);
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const runner = options.runner ?? defaultRunner;
  const log = options.log ?? console.log;
  const prompt = options.prompt ?? defaultPrompt;
  if (!parsed.command || parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") return printHelp(log);
  if (parsed.command === "quickstart") {
    const { runQuickstart } = await import("./quickstart.js");
    return runQuickstart({ cwd, target: parsed.target, env, runner, log });
  }
  if (parsed.command === "create") return createProject(parsed, { cwd, env, isTTY, runner, log, prompt });
  if (parsed.command === "init") return initProject(parsed.target, cwd, log);
  const target = resolve(cwd, parsed.target ?? ".");
  if (parsed.command === "setup") return setupProject(target, parsed, { env, isTTY, log, prompt });
  if (parsed.command === "deploy") {
    const state = await deployProject(target, { runner, env, prompt, account: parsed.account, log });
    log(`Deployment ready: ${state.deployedUrl ?? state.workerName}`);
    return;
  }
  if (parsed.command === "doctor") return doctorProject(target, { env, runner, log });
  throw new Error(`Unknown Flary command: ${parsed.command}\nRun "flary help" for usage.`);
}
