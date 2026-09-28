import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareQuickstartProject, type CommandRunner } from "../src/cli-api.ts";
import { startQuickstartServer } from "../src/quickstart.ts";

const runner: CommandRunner = {
  async run() {
    return { code: 0, stdout: "", stderr: "" };
  },
};

test("the quick start generates an exact Gemini widget project without public secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-quickstart-project-"));
  const target = path.join(root, "widget");
  try {
    const state = await prepareQuickstartProject(
      {
        target,
        accountId: "account-1",
        workerName: "my-widget",
        agentName: "Docs guide",
        systemPrompt: "Answer from the product documentation.",
        provider: "google",
        model: "gemini-2.5-flash",
        providerKey: "google-secret-value",
      },
      { runner, env: {}, log: () => undefined },
    );
    assert.equal(state.model, "gemini-2.5-flash");
    assert.ok(state.requiredSecrets.includes("GEMINI_API_KEY"));
    const stateText = await readFile(path.join(target, ".flary", "project.json"), "utf8");
    assert.doesNotMatch(stateText, /google-secret-value/);
    assert.match(
      await readFile(path.join(target, "src", "flary.generated.ts"), "utf8"),
      /google\/gemini-2\.5-flash/,
    );
    assert.match(
      await readFile(path.join(target, "src", "assistant.generated.ts"), "utf8"),
      /Answer from the product documentation/,
    );
    assert.match(
      await readFile(path.join(target, "src", "widget.ts"), "utf8"),
      /customElements\.define/,
    );
    assert.match(
      await readFile(path.join(target, "examples", "FlaryChat.tsx"), "utf8"),
      /flary-chat/,
    );
    assert.equal((await stat(path.join(target, ".dev.vars"))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the localhost server uses an OAuth-compatible HttpOnly session and exact origin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-quickstart-server-"));
  const port = 44000 + Math.floor(Math.random() * 1000);
  const server = await startQuickstartServer({
    cwd: root,
    target: "widget",
    port,
    openBrowser: false,
    runner,
    env: {},
    log: () => undefined,
  });
  try {
    const page = await fetch(server.url);
    const pageText = await page.text();
    const cookie = page.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.match(pageText, /Your assistant/);
    const missingSession = await fetch(`${server.url}/api/status`);
    assert.equal(missingSession.status, 401);
    const sessionCookie = cookie.split(";", 1)[0];
    const status = await fetch(`${server.url}/api/status`, { headers: { cookie: sessionCookie } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).oauthSupported, false);
    const wrongOrigin = await fetch(`${server.url}/api/cloudflare/oauth`, {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: "http://localhost:43817",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(wrongOrigin.status, 403);
    const deniedCallback = await fetch(
      `${server.url}/oauth/callback?state=wrong&error=access_denied`,
      {
        headers: { cookie: sessionCookie },
        redirect: "manual",
      },
    );
    assert.equal(deniedCallback.status, 303);
    assert.equal(deniedCallback.headers.get("location"), "/");
    const recovery = await fetch(`${server.url}/api/status`, {
      headers: { cookie: sessionCookie },
    }).then((response) => response.json());
    assert.match(recovery.error, /Start authorization again/);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("setup drafts survive refresh without storing secrets or granting account access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-draft-"));
  const port = 45000 + Math.floor(Math.random() * 1000);
  const server = await startQuickstartServer({
    cwd: root,
    target: "widget",
    port,
    openBrowser: false,
    runner,
    env: {},
    log: () => undefined,
  });
  try {
    const page = await fetch(server.url);
    const cookie = page.headers.get("set-cookie")!.split(";", 1)[0];
    const headers = { cookie, origin: server.url, "content-type": "application/json" };
    const draft = await fetch(`${server.url}/api/draft`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        agentName: "My helper",
        step: 1,
        systemPrompt: "Help with docs",
        provider: "openai",
        model: "gpt-5",
        providerKey: "must-not-persist",
        cloudflareAccessToken: "also-private",
        phase: "deployed",
      }),
    });
    assert.equal(draft.status, 200);
    const persisted = await readFile(path.join(root, "widget/.flary/quickstart.json"), "utf8");
    assert.doesNotMatch(persisted, /must-not-persist|also-private|deployed/);
    const state = await fetch(`${server.url}/api/status`, { headers }).then((r) => r.json());
    assert.equal(state.config.agentName, "My helper");
    assert.equal(state.step, 1);
    assert.equal(state.config.provider, "openai");
    assert.equal(state.config.hasProviderKey, false);
    assert.equal(state.busy, false);
    const unauthorized = await fetch(`${server.url}/api/draft`, {
      method: "POST",
      headers,
      body: JSON.stringify({ accountId: "not-connected" }),
    });
    assert.equal(unauthorized.status, 400);
    const crossOrigin = await fetch(`${server.url}/api/draft`, {
      method: "POST",
      headers: { ...headers, origin: "https://example.com" },
      body: "{}",
    });
    assert.equal(crossOrigin.status, 403);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("quickstart creates a project beside its saved draft but refuses unrelated files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-draft-scaffold-"));
  const target = path.join(root, "widget");
  const input = {
    target,
    accountId: "account-1",
    workerName: "my-helper",
    agentName: "My helper",
    systemPrompt: "Help",
    provider: "workers-ai" as const,
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  };
  try {
    await mkdir(path.join(target, ".flary"), { recursive: true });
    await writeFile(
      path.join(target, ".flary/quickstart.json"),
      '{"version":1,"phase":"connected"}',
    );
    await writeFile(path.join(target, "important.txt"), "keep me");
    await assert.rejects(prepareQuickstartProject(input, { runner, env: {} }), /not empty/);
    assert.equal(await readFile(path.join(target, "important.txt"), "utf8"), "keep me");
    await rm(path.join(target, "important.txt"));
    const state = await prepareQuickstartProject(input, { runner, env: {} });
    assert.equal(state.workerName, "my-helper");
    assert.equal(
      JSON.parse(await readFile(path.join(target, ".flary/quickstart.json"), "utf8")).phase,
      "connected",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("connected setup exposes real preparation progress and rejects overlapping changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-progress-"));
  let releaseInstall!: () => void;
  let started!: () => void;
  const installing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const finishInstall = new Promise<void>((resolve) => {
    releaseInstall = resolve;
  });
  const controlledRunner: CommandRunner = {
    async run(_command, args) {
      if (args.includes("whoami"))
        return {
          code: 0,
          stdout: JSON.stringify({ accounts: [{ id: "account-1", name: "Test" }] }),
          stderr: "",
        };
      if (args.includes("install")) {
        started();
        await finishInstall;
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const server = await startQuickstartServer({
    cwd: root,
    target: "widget",
    port: 46000 + Math.floor(Math.random() * 1000),
    openBrowser: false,
    runner: controlledRunner,
    env: {},
    log: () => undefined,
  });
  try {
    const page = await fetch(server.url);
    const headers = {
      cookie: page.headers.get("set-cookie")!.split(";", 1)[0],
      origin: server.url,
      "content-type": "application/json",
    };
    const post = (route: string, body: Record<string, string>) =>
      fetch(`${server.url}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await post("/api/cloudflare/wrangler", {})).status, 200);
    const preparation = post("/api/project", {
      accountId: "account-1",
      workerName: "helper",
      agentName: "Helper",
      systemPrompt: "Help with docs",
      provider: "workers-ai",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    });
    await installing;
    const status = await fetch(`${server.url}/api/status`, { headers }).then((r) => r.json());
    assert.equal(status.busy, true);
    assert.equal(status.progress.stage, "prepare");
    assert.equal((await post("/api/draft", { agentName: "Changed" })).status, 409);
    releaseInstall();
    const prepared = await preparation;
    assert.equal(prepared.status, 200);
    const result = await prepared.json();
    assert.equal(result.phase, "configured");
    assert.equal(result.busy, false);
    assert.equal(result.progress.stage, "prepared");
  } finally {
    releaseInstall();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Cloudflare connection checks reuse verified credentials without starting login", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-connection-"));
  let signedIn = true;
  let loginCalls = 0;
  const authRunner: CommandRunner = {
    async run(_command, args) {
      if (args.includes("login")) {
        loginCalls++;
        signedIn = true;
      }
      return args.includes("whoami")
        ? {
            code: signedIn ? 0 : 1,
            stdout: signedIn
              ? JSON.stringify({ accounts: [{ id: "verified-account", name: "My account" }] })
              : "",
            stderr: "",
          }
        : { code: 0, stdout: "", stderr: "" };
    },
  };
  const server = await startQuickstartServer({
    cwd: root,
    target: "widget",
    port: 47000 + Math.floor(Math.random() * 1000),
    openBrowser: false,
    runner: authRunner,
    env: {},
    log: () => undefined,
  });
  try {
    const page = await fetch(server.url);
    const headers = {
      cookie: page.headers.get("set-cookie")!.split(";", 1)[0],
      origin: server.url,
      "content-type": "application/json",
    };
    const post = (route: string) =>
      fetch(`${server.url}${route}`, { method: "POST", headers, body: "{}" });
    const verified = await post("/api/cloudflare/check").then((r) => r.json());
    assert.equal(verified.cloudflareConnected, true);
    assert.equal(verified.phase, "welcome", "existing auth must not skip the assistant setup step");
    assert.equal(loginCalls, 0);
    const refreshed = await fetch(`${server.url}/api/status`, { headers }).then((r) => r.json());
    assert.equal(refreshed.cloudflareConnected, true);
    await post("/api/cloudflare/wrangler");
    assert.equal(loginCalls, 0, "Connect reuses existing auth");
    signedIn = false;
    const disconnected = await post("/api/cloudflare/check").then((r) => r.json());
    assert.equal(disconnected.cloudflareConnected, false);
    assert.equal(loginCalls, 0, "a read-only check never opens login");
    const reconnected = await post("/api/cloudflare/wrangler").then((r) => r.json());
    assert.equal(reconnected.cloudflareConnected, true);
    assert.equal(loginCalls, 1);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
