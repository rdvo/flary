import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deploymentUrl,
  parseWranglerAccounts,
  parseWranglerSecretNames,
  runFlaryCli,
  type CliPrompt,
  type CommandRunner,
} from "../src/cli-api.ts";

function queuedPrompt(values: unknown[]): CliPrompt {
  const next = async () => values.shift();
  return {
    intro: () => undefined,
    select: next,
    multiselect: next,
    confirm: next,
    text: next,
    password: next,
    isCancel: () => false,
    cancel: () => undefined,
  };
}

test("legacy non-TTY create keeps backend and no-deploy behavior", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-cli-legacy-"));
  try {
    const messages: string[] = [];
    await runFlaryCli(["create", "example"], {
      cwd: root,
      isTTY: false,
      log: (message) => messages.push(message),
    });
    const target = path.join(root, "example");
    const state = JSON.parse(
      await readFile(path.join(target, ".flary", "project.json"), "utf8")
    );
    assert.equal(state.template, "backend");
    assert.equal(state.provider, "openai");
    assert.equal(state.requiredSecrets.includes("FLARY_ACCESS_TOKEN"), false);
    assert.match(
      await readFile(path.join(target, "src", "coder.ts"), "utf8"),
      /app\.agent/
    );
    assert.ok(messages.some((message) => message.includes("npm install")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-interactive dashboard create stores only secret names in project state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-cli-dashboard-"));
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  try {
    await runFlaryCli(
      [
        "create",
        "personal",
        "--template",
        "dashboard",
        "--provider",
        "none",
        "--features",
        "mcp",
        "--package-manager",
        "npm",
        "--no-deploy",
        "--yes",
      ],
      { cwd: root, isTTY: false, runner, env: {}, log: () => undefined }
    );
    const target = path.join(root, "personal");
    const stateText = await readFile(
      path.join(target, ".flary", "project.json"),
      "utf8"
    );
    const state = JSON.parse(stateText);
    assert.deepEqual(state.features, ["mcp"]);
    assert.ok(state.requiredSecrets.includes("BETTER_AUTH_SECRET"));
    assert.equal(state.requiredSecrets.includes("GITHUB_MCP_PAT"), false);
    assert.doesNotMatch(stateText, /[a-f0-9]{48,}/);
    const devVars = await readFile(path.join(target, ".dev.vars"), "utf8");
    assert.match(devVars, /FLARY_SETUP_TOKEN=/);
    assert.equal(
      (await stat(path.join(target, ".dev.vars"))).mode & 0o777,
      0o600
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, "npm");
    const wrangler = JSON.parse(
      await readFile(path.join(target, "wrangler.jsonc"), "utf8")
    );
    assert.ok(wrangler.secrets.required.includes("FLARY_SETUP_TOKEN"));
    assert.deepEqual(wrangler.d1_databases, [
      { binding: "FLARY_DASHBOARD_DB" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guided create covers dashboard, Workers AI, optional features, and no deploy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-cli-guided-"));
  const runner: CommandRunner = {
    async run() {
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  try {
    await runFlaryCli(["create", "guided"], {
      cwd: root,
      isTTY: true,
      runner,
      prompt: queuedPrompt([
        "dashboard",
        "workers-ai",
        "npm",
        ["browser"],
        false,
      ]),
      log: () => undefined,
    });
    const target = path.join(root, "guided");
    const state = JSON.parse(
      await readFile(path.join(target, ".flary", "project.json"), "utf8")
    );
    assert.equal(state.provider, "workers-ai");
    assert.deepEqual(state.features, ["mcp", "browser"]);
    const wrangler = JSON.parse(
      await readFile(path.join(target, "wrangler.jsonc"), "utf8")
    );
    assert.deepEqual(wrangler.ai, { binding: "AI" });
    assert.equal(state.requiredSecrets.includes("OPENAI_API_KEY"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-interactive mail create configures restricted addresses and Cloudflare resources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-cli-mail-"));
  const runner: CommandRunner = {
    async run() {
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  try {
    await runFlaryCli(
      [
        "create",
        "mail",
        "--template",
        "mail",
        "--domain",
        "example.com",
        "--mailboxes",
        "admin,support",
        "--package-manager",
        "npm",
        "--no-deploy",
        "--yes",
      ],
      { cwd: root, isTTY: false, runner, env: {}, log: () => undefined }
    );
    const target = path.join(root, "mail");
    const state = JSON.parse(
      await readFile(path.join(target, ".flary", "project.json"), "utf8")
    );
    assert.equal(state.template, "mail");
    assert.equal(state.provider, "none");
    assert.equal(state.mailDomain, "example.com");
    assert.deepEqual(state.mailboxes, ["admin", "support"]);
    assert.deepEqual(
      state.requiredSecrets.sort(),
      ["BETTER_AUTH_SECRET", "FLARY_SETUP_TOKEN"].sort()
    );
    const wrangler = JSON.parse(
      await readFile(path.join(target, "wrangler.jsonc"), "utf8")
    );
    assert.deepEqual(wrangler.addresses, [
      "admin@example.com",
      "support@example.com",
    ]);
    assert.deepEqual(wrangler.send_email, [
      {
        name: "EMAIL",
        allowed_sender_addresses: ["admin@example.com", "support@example.com"],
      },
    ]);
    assert.deepEqual(wrangler.vars, {
      MAIL_DOMAIN: "example.com",
      MAILBOX_ADDRESSES: "admin@example.com,support@example.com",
    });
    assert.equal(wrangler.queues.producers[0].queue, "mail-jobs");
    assert.match(
      await readFile(path.join(target, ".dev.vars"), "utf8"),
      /FLARY_SETUP_TOKEN=/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-interactive provider setup fails when its key is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-cli-required-"));
  try {
    await assert.rejects(
      runFlaryCli(
        [
          "create",
          "missing",
          "--template",
          "backend",
          "--provider",
          "openai",
          "--package-manager",
          "npm",
          "--no-deploy",
          "--yes",
        ],
        { cwd: root, isTTY: false, env: {}, log: () => undefined }
      ),
      /OPENAI_API_KEY is required/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup reconstructs non-secret state after an interrupted create", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-cli-resume-"));
  const runner: CommandRunner = {
    async run() {
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  try {
    await runFlaryCli(
      [
        "create",
        "resume",
        "--template",
        "dashboard",
        "--provider",
        "none",
        "--package-manager",
        "npm",
        "--no-deploy",
        "--yes",
      ],
      { cwd: root, isTTY: false, runner, env: {}, log: () => undefined }
    );
    const target = path.join(root, "resume");
    await rm(path.join(target, ".flary", "project.json"));
    await runFlaryCli(["setup", "--provider", "none", "--features", "mcp"], {
      cwd: target,
      isTTY: false,
      env: {},
      log: () => undefined,
    });
    const state = JSON.parse(
      await readFile(path.join(target, ".flary", "project.json"), "utf8")
    );
    assert.equal(state.template, "dashboard");
    assert.deepEqual(state.features, ["mcp"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deploy passes a permission-restricted secrets file and always removes it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-cli-secrets-"));
  const target = path.join(root, "backend");
  let secretPath: string | undefined;
  let secretMode: number | undefined;
  let wranglerCommand: string | undefined;
  const runner: CommandRunner = {
    async run(command, args) {
      if (command === "npm") return { code: 0, stdout: "", stderr: "" };
      wranglerCommand = command;
      if (args.includes("whoami")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            accounts: [{ id: "account-1", name: "Test" }],
          }),
          stderr: "",
        };
      }
      if (args.includes("--dry-run"))
        return { code: 0, stdout: "", stderr: "" };
      if (args.includes("deploy")) {
        const index = args.indexOf("--secrets-file");
        secretPath = String(args[index + 1]);
        secretMode = (await stat(secretPath)).mode & 0o777;
        const contents = await readFile(secretPath, "utf8");
        assert.match(contents, /FLARY_INTERNAL_TOKEN/);
        assert.ok(
          !args.join(" ").includes(JSON.parse(contents).FLARY_INTERNAL_TOKEN)
        );
        return { code: 1, stdout: "", stderr: "expected failure" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  try {
    await runFlaryCli(
      [
        "create",
        "backend",
        "--template",
        "backend",
        "--provider",
        "none",
        "--package-manager",
        "npm",
        "--no-deploy",
        "--yes",
      ],
      { cwd: root, isTTY: false, runner, env: {}, log: () => undefined }
    );
    await mkdir(path.join(target, "node_modules"));
    const hoistedWrangler = path.join(
      root,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "wrangler.cmd" : "wrangler"
    );
    await mkdir(path.dirname(hoistedWrangler), { recursive: true });
    await writeFile(hoistedWrangler, "");
    await assert.rejects(
      runFlaryCli(["deploy"], {
        cwd: target,
        isTTY: false,
        runner,
        env: {},
        log: () => undefined,
      }),
      /Wrangler deployment failed/
    );
    assert.equal(secretMode, 0o600);
    assert.equal(wranglerCommand, hoistedWrangler);
    assert.ok(secretPath);
    await assert.rejects(stat(secretPath!));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Wrangler secret JSON is normalized", () => {
  assert.deepEqual(
    parseWranglerSecretNames(
      JSON.stringify([
        { name: "FLARY_INTERNAL_TOKEN", type: "secret_text" },
        { name: "GEMINI_API_KEY", type: "secret_text" },
        { type: "secret_text" },
      ])
    ),
    ["FLARY_INTERNAL_TOKEN", "GEMINI_API_KEY"]
  );
});

test("deploy keeps required secrets that already exist on the Worker", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "flary-cli-remote-secrets-")
  );
  const target = path.join(root, "backend");
  const calls: string[] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "npm") return { code: 0, stdout: "", stderr: "" };
      if (args.includes("whoami"))
        return {
          code: 0,
          stdout: JSON.stringify({
            accounts: [{ id: "account-1", name: "Test" }],
          }),
          stderr: "",
        };
      if (args.includes("--dry-run"))
        return { code: 0, stdout: "", stderr: "" };
      if (args.includes("secret") && args.includes("list"))
        return {
          code: 0,
          stdout: JSON.stringify([
            { name: "FLARY_INTERNAL_TOKEN", type: "secret_text" },
            { name: "FLARY_SESSION_ARCHIVE_KEY", type: "secret_text" },
            { name: "FLARY_ACCESS_TOKEN", type: "secret_text" },
          ]),
          stderr: "",
        };
      if (args.includes("deploy"))
        return { code: 1, stdout: "", stderr: "expected failure" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  try {
    await runFlaryCli(
      [
        "create",
        "backend",
        "--template",
        "backend",
        "--provider",
        "none",
        "--package-manager",
        "npm",
        "--no-deploy",
        "--yes",
      ],
      { cwd: root, isTTY: false, runner, env: {}, log: () => undefined }
    );
    await mkdir(path.join(target, "node_modules"));
    await rm(path.join(target, ".dev.vars"));
    await assert.rejects(
      runFlaryCli(["deploy"], {
        cwd: target,
        isTTY: false,
        runner,
        env: {},
        log: () => undefined,
      }),
      /Wrangler deployment failed/
    );
    assert.ok(calls.some((call) => call.includes("secret list")));
    assert.ok(
      calls.some(
        (call) =>
          call.includes(" deploy") &&
          !call.includes("--dry-run") &&
          !call.includes("--secrets-file")
      )
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deploy falls back from the keyring flag and persists the selected account", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-cli-account-"));
  const target = path.join(root, "backend");
  const calls: string[] = [];
  let whoami = 0;
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "npm") return { code: 0, stdout: "", stderr: "" };
      if (args.includes("whoami")) {
        whoami += 1;
        return whoami === 1
          ? { code: 1, stdout: '{"loggedIn":false}', stderr: "" }
          : {
              code: 0,
              stdout: JSON.stringify({
                accounts: [
                  { id: "one", name: "One" },
                  { id: "two", name: "Two" },
                ],
              }),
              stderr: "",
            };
      }
      if (args.includes("--use-keyring"))
        return { code: 1, stdout: "", stderr: "Unknown argument: use-keyring" };
      if (args.includes("login")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("--dry-run"))
        return { code: 0, stdout: "", stderr: "" };
      if (args.includes("deploy"))
        return { code: 1, stdout: "", stderr: "stop after account selection" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  try {
    await runFlaryCli(
      [
        "create",
        "backend",
        "--template",
        "backend",
        "--provider",
        "none",
        "--package-manager",
        "npm",
        "--no-deploy",
        "--yes",
      ],
      { cwd: root, isTTY: false, runner, env: {}, log: () => undefined }
    );
    await mkdir(path.join(target, "node_modules"));
    await assert.rejects(
      runFlaryCli(["deploy"], {
        cwd: target,
        isTTY: true,
        runner,
        env: {},
        prompt: queuedPrompt(["two"]),
        log: () => undefined,
      }),
      /Wrangler deployment failed/
    );
    const state = JSON.parse(
      await readFile(path.join(target, ".flary", "project.json"), "utf8")
    );
    assert.equal(state.accountId, "two");
    assert.ok(calls.some((call) => call.includes("login --use-keyring")));
    assert.ok(calls.some((call) => call.endsWith("login")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mail deploy enables routing and sending before Worker deployment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-cli-mail-deploy-"));
  const target = path.join(root, "mail");
  const calls: string[] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push(`${path.basename(command)} ${args.join(" ")}`);
      if (command === "npm") return { code: 0, stdout: "", stderr: "" };
      if (args.includes("whoami")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            accounts: [{ id: "account-1", name: "Test" }],
          }),
          stderr: "",
        };
      }
      if (args.includes("sending") && args.includes("enable")) {
        return {
          code: 1,
          stdout: "",
          stderr: "Subdomain already exists [code: 2040]",
        };
      }
      if (args.includes("--dry-run"))
        return { code: 0, stdout: "", stderr: "" };
      if (args.includes("deploy")) {
        return { code: 1, stdout: "", stderr: "expected failure" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  try {
    await runFlaryCli(
      [
        "create",
        "mail",
        "--template",
        "mail",
        "--domain",
        "example.com",
        "--mailboxes",
        "admin",
        "--package-manager",
        "npm",
        "--no-deploy",
        "--yes",
      ],
      { cwd: root, isTTY: false, runner, env: {}, log: () => undefined }
    );
    await mkdir(path.join(target, "node_modules"));
    await assert.rejects(
      runFlaryCli(["deploy"], {
        cwd: target,
        isTTY: false,
        runner,
        env: {},
        log: () => undefined,
      }),
      /Wrangler deployment failed/
    );
    const routing = calls.findIndex((call) =>
      call.includes("email routing enable example.com")
    );
    const validation = calls.findIndex((call) =>
      call.includes("deploy --dry-run")
    );
    const sending = calls.findIndex((call) =>
      call.includes("email sending enable example.com")
    );
    const deploy = calls.findIndex((call) =>
      call.includes(" deploy --secrets-file")
    );
    assert.ok(validation >= 0);
    assert.ok(routing > validation);
    assert.ok(sending > routing);
    assert.ok(deploy > sending);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Wrangler account JSON is normalized", () => {
  assert.deepEqual(
    parseWranglerAccounts(
      JSON.stringify({
        accounts: [{ id: "a", name: "Alpha" }, { account_id: "b" }],
      })
    ),
    [
      { id: "a", name: "Alpha" },
      { id: "b", name: "b" },
    ]
  );
});

test("deployment URL recognizes a Wrangler custom domain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-custom-domain-"));
  try {
    assert.equal(
      await deploymentUrl(
        "  mail.example.com (custom domain)\n",
        path.join(root, "missing.ndjson")
      ),
      "https://mail.example.com"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
