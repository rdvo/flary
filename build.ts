import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import arg from "arg";
import { build, context, BuildOptions, Plugin } from "esbuild";
import * as glob from "glob";

const args = arg({
  "--watch": Boolean,
  "--force": Boolean,
});

const isWatch = args["--watch"] || false;
const isForce = args["--force"] || false;
const execFileAsync = promisify(execFile);

function removeDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    return;
  }

  if (!isForce) {
    const stat = fs.statSync(dirPath);
    if (stat.isDirectory() && fs.readdirSync(dirPath).length > 0) {
      console.warn(
        `Warning: ${dirPath} is not empty. Use --force to overwrite.`
      );
      return;
    }
  }

  fs.readdirSync(dirPath).forEach((file) => {
    const filePath = path.join(dirPath, file);
    if (fs.lstatSync(filePath).isDirectory()) {
      removeDir(filePath);
    } else {
      fs.unlinkSync(filePath);
    }
  });
  fs.rmdirSync(dirPath);
}

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

const addExtension = (
  extension: string = ".js",
  fileExtension: string = ".ts"
): Plugin => ({
  name: "add-extension",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.importer) {
        const p = path.join(args.resolveDir, args.path);
        let tsPath = `${p}${fileExtension}`;

        let importPath = "";
        if (fs.existsSync(tsPath)) {
          importPath = args.path + extension;
        } else if (fileExtension === ".ts" && fs.existsSync(`${p}.tsx`)) {
          importPath = args.path + extension;
        } else {
          tsPath = path.join(
            args.resolveDir,
            args.path,
            `index${fileExtension}`
          );
          if (fs.existsSync(tsPath)) {
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

const esmBuild = async () => {
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

const cliBuild = async () => {
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

removeDir("./dist");

async function main() {
  if (isWatch) {
    const typecheck = execFile("tsc", [
      "-w",
      "--project",
      "tsconfig.build.json",
    ]);
    typecheck.stdout?.pipe(process.stdout);
    typecheck.stderr?.pipe(process.stderr);
    await Promise.all([esmBuild(), cliBuild()]);
    return;
  }

  await execFileAsync("tsc", ["--project", "tsconfig.build.json"]);
  await Promise.all([esmBuild(), cliBuild()]);
}

main().catch((error: unknown) => {
  console.error("Build failed.");
  console.error(error);
  process.exitCode = 1;
});
