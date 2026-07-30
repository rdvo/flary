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

function printHelp(): void {
  console.log(`Flary

Usage:
  flary create [directory]   Create a local function Worker starter
  flary init [directory]     Add function-first files
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
      path: join(target, "src", "flary.ts"),
      content: appSource,
    },
    {
      path: join(target, "src", "tools.ts"),
      content: toolsSource,
    },
    {
      path: join(target, "src", "support.ts"),
      content: supportSource,
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
  console.log("\nRun your package manager install command, then call:");
  console.log('  import { support } from "./src/support";');
  console.log('  await support({ question: "How do I upgrade?" });');
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
