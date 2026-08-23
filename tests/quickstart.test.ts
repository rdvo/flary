import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareQuickstartProject, type CommandRunner } from "../src/cli-api.ts";
import { startQuickstartServer } from "../src/quickstart.ts";

const runner: CommandRunner = { async run() { return { code: 0, stdout: "", stderr: "" }; } };

test("the quick start generates an exact Gemini widget project without public secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-quickstart-project-"));
  const target = path.join(root, "widget");
  try {
    const state = await prepareQuickstartProject({
      target,
      accountId: "account-1",
      workerName: "my-widget",
      agentName: "Docs guide",
      systemPrompt: "Answer from the product documentation.",
      provider: "google",
      model: "gemini-2.5-flash",
      providerKey: "google-secret-value",
    }, { runner, env: {}, log: () => undefined });
    assert.equal(state.model, "gemini-2.5-flash");
    assert.ok(state.requiredSecrets.includes("GEMINI_API_KEY"));
    const stateText = await readFile(path.join(target, ".flary", "project.json"), "utf8");
    assert.doesNotMatch(stateText, /google-secret-value/);
    assert.match(await readFile(path.join(target, "src", "flary.generated.ts"), "utf8"), /google\/gemini-2\.5-flash/);
    assert.match(await readFile(path.join(target, "src", "assistant.generated.ts"), "utf8"), /Answer from the product documentation/);
    assert.match(await readFile(path.join(target, "src", "widget.ts"), "utf8"), /customElements\.define/);
    assert.match(await readFile(path.join(target, "examples", "FlaryChat.tsx"), "utf8"), /flary-chat/);
    assert.equal((await stat(path.join(target, ".dev.vars"))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the localhost server requires its HttpOnly session and exact origin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flary-quickstart-server-"));
  const port = 44000 + Math.floor(Math.random() * 1000);
  const server = await startQuickstartServer({ cwd: root, target: "widget", port, openBrowser: false, runner, env: {}, log: () => undefined });
  try {
    const page = await fetch(server.url);
    const pageText = await page.text();
    const cookie = page.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.match(pageText, /id="cloudflare-next"[^>]*disabled/);
    const missingSession = await fetch(`${server.url}/api/status`);
    assert.equal(missingSession.status, 401);
    const sessionCookie = cookie.split(";", 1)[0];
    const status = await fetch(`${server.url}/api/status`, { headers: { cookie: sessionCookie } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).oauthSupported, false);
    const wrongOrigin = await fetch(`${server.url}/api/cloudflare/oauth`, {
      method: "POST",
      headers: { cookie: sessionCookie, origin: "http://localhost:43817", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(wrongOrigin.status, 403);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
