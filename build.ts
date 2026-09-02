import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import arg from "arg";
import { build, context, type BuildOptions, type Plugin } from "esbuild";
import * as glob from "glob";

const args = arg({
  "--watch": Boolean,
});

const isWatch = args["--watch"] ?? false;
const execFileAsync = promisify(execFile);

const entryPoints = glob.sync(["./src/**/*.ts", "./src/**/*.tsx"], {
  ignore: [
    "./src/cli.ts",
    "./src/cli-api.ts",
    "./src/quickstart.ts",
    "./src/**/*.test.ts",
    "./src/**/*.test.tsx",
    "./src/mod.ts",
    "./src/middleware.ts",
    "./src/deno/**/*.ts",
  ],
});

const addExtension = (extension: string = ".js", fileExtension: string = ".ts"): Plugin => ({
  name: "add-extension",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.importer) {
        const candidatePath = path.join(args.resolveDir, args.path);
        let sourcePath = `${candidatePath}${fileExtension}`;

        let importPath = "";
        if (fs.existsSync(sourcePath)) {
          importPath = args.path + extension;
        } else if (fileExtension === ".ts" && fs.existsSync(`${candidatePath}.tsx`)) {
          importPath = args.path + extension;
        } else {
          sourcePath = path.join(args.resolveDir, args.path, `index${fileExtension}`);
          if (fs.existsSync(sourcePath)) {
            importPath = `${args.path}/index${extension}`;
          } else if (
            fileExtension === ".ts" &&
            fs.existsSync(path.join(args.resolveDir, args.path, "index.tsx"))
          ) {
            importPath = `${args.path}/index${extension}`;
          }
        }
        return { path: importPath, external: true };
      }
    });
  },
});

const commonOptions: BuildOptions = {
  entryPoints,
  logLevel: "info",
  platform: "neutral",
  external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"],
};

const esmBuild = async (): Promise<void> => {
  const buildOptions: BuildOptions = {
    ...commonOptions,
    bundle: true,
    outbase: "./src",
    outdir: "./dist",
    format: "esm",
    plugins: [addExtension(".js")],
  };

  if (isWatch) {
    const ctx = await context(buildOptions);
    await ctx.watch();
  } else {
    await build(buildOptions);
  }
};

const cliBuild = async (): Promise<void> => {
  const buildOptions: BuildOptions = {
    entryPoints: ["./src/cli.ts", "./src/cli-api.ts", "./src/quickstart.ts"],
    outbase: "./src",
    outdir: "./dist",
    format: "esm",
    platform: "node",
    bundle: false,
    banner: {
      js: "#!/usr/bin/env node",
    },
  };

  if (isWatch) {
    const ctx = await context(buildOptions);
    await ctx.watch();
  } else {
    await build(buildOptions);
  }
};

async function main(): Promise<void> {
  if (isWatch) {
    const typecheck = execFile("tsc", ["-w", "--project", "tsconfig.build.json"]);
    typecheck.stdout?.pipe(process.stdout);
    typecheck.stderr?.pipe(process.stderr);
    await Promise.all([esmBuild(), cliBuild()]);
    return;
  }

  await execFileAsync("tsc", ["--project", "tsconfig.build.json"]);
  await Promise.all([esmBuild(), cliBuild()]);
}

void main().catch((error: unknown) => {
  console.error("Build failed.");
  console.error(error);
  process.exitCode = 1;
});
