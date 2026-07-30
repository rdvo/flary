import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const starterRoot = join(packageRoot, "templates", "starter");

type PackageManifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const agentSource = `import { compilePrompt } from "flary/prompts";

export function createSupportPrompt(source: string, input: {
  customer: { name: string };
  question: string;
}) {
  return compilePrompt(
    {
      path: "prompts/support/answer.prompt.md",
      content: source,
    },
    {
      callerModel: "openai/gpt-5",
      values: input,
    },
  );
}
`;

const promptSource = `---
model: inherit
thinking: high
tools:
  - docs.search

input:
  customer.name: string
  question: string
---

Answer {{customer.name}} with a concise, sourced response:

{{question}}
`;

function printHelp(): void {
  console.log(`Flary

Usage:
  flary create [directory]   Create a local prompt Worker starter
  flary init [directory]     Add prompt files and a compiler helper
  flary help                 Show this help
`);
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

async function createProject(targetArg?: string): Promise<void> {
  const target = resolve(process.cwd(), targetArg ?? "flary-agent");
  if (await exists(target)) {
    const entries = await readdir(target);
    if (entries.length > 0) {
      throw new Error(`Target directory is not empty: ${target}`);
    }
  } else {
    await mkdir(target, { recursive: true });
  }

  await cp(starterRoot, target, { recursive: true });
  await rename(join(target, "gitignore"), join(target, ".gitignore"));

  const manifestPath = join(target, "package.json");
  const manifest = await readManifest(manifestPath);
  manifest.name =
    target.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "") || "flary-agent";
  manifest.dependencies = {
    ...manifest.dependencies,
    flary: await packageVersion(),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Created ${target}`);
  console.log("\nNext steps:");
  console.log(`  cd ${target}`);
  console.log("  npm install");
  console.log("  npm run dev");
}

async function writeIfMissing(
  path: string,
  content: string,
): Promise<"created" | "skipped"> {
  if (await exists(path)) return "skipped";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { flag: "wx" });
  return "created";
}

async function initProject(targetArg?: string): Promise<void> {
  const target = resolve(process.cwd(), targetArg ?? ".");
  const manifestPath = join(target, "package.json");
  if (!(await exists(manifestPath))) {
    throw new Error(
      `No package.json was found in ${target}. Use "flary create" for a new project.`,
    );
  }

  const manifest = await readManifest(manifestPath);
  if (!manifest.dependencies?.flary && !manifest.devDependencies?.flary) {
    manifest.dependencies = {
      ...manifest.dependencies,
      flary: await packageVersion(),
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const files = [
    {
      path: join(target, "src", "flary", "support.ts"),
      content: agentSource,
    },
    {
      path: join(target, "prompts", "support", "answer.prompt.md"),
      content: promptSource,
    },
  ];
  const results = await Promise.all(
    files.map(async (file) => ({
      path: file.path,
      status: await writeIfMissing(file.path, file.content),
    })),
  );

  console.log(`Initialized Flary in ${target}`);
  for (const result of results) {
    console.log(`  ${result.status === "created" ? "created" : "kept"} ${result.path}`);
  }
  console.log("\nRun your package manager install command, then import:");
  console.log('  import { createSupportPrompt } from "./flary/support";');
  console.log("  Pass the prompt file content using your framework's file loader.");
}

export async function runFlaryCli(args: readonly string[]): Promise<void> {
  const [command, target] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "create") {
    await createProject(target);
    return;
  }
  if (command === "init") {
    await initProject(target);
    return;
  }
  throw new Error(`Unknown Flary command: ${command}\nRun "flary help" for usage.`);
}
