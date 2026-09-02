import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";

import {
  deployQuickstartProject,
  parseWranglerAccounts,
  prepareQuickstartProject,
  type CommandRunner,
  type FlaryProjectState,
  type Provider,
} from "./cli-api.js";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 43817;
const SESSION_LIFETIME_MS = 20 * 60_000;
const OAUTH_SCOPES = ["account.read", "workers-platform.read", "workers-platform.write"];

export interface QuickstartServerOptions {
  readonly cwd?: string;
  readonly target?: string;
  readonly port?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly runner?: CommandRunner;
  readonly openBrowser?: boolean;
  readonly log?: (message: string) => void;
}

export interface QuickstartServer {
  readonly url: string;
  close(): Promise<void>;
}

interface SetupRecord {
  readonly version: 1;
  readonly phase: "welcome" | "connected" | "configured" | "deployed";
  readonly accountId?: string;
  readonly workerName?: string;
  readonly agentName?: string;
  readonly systemPrompt?: string;
  readonly provider?: Provider;
  readonly model?: string;
  readonly deployedUrl?: string;
}

interface SessionState {
  readonly id: string;
  readonly expiresAt: number;
  oauthState?: string;
  codeVerifier?: string;
  cloudflareAccessToken?: string;
  accounts?: Array<{ id: string; name: string }>;
}

export async function startQuickstartServer(
  options: QuickstartServerOptions = {},
): Promise<QuickstartServer> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const target = resolve(cwd, options.target ?? "flary-widget");
  const env = options.env ?? process.env;
  const runner = options.runner ?? commandRunner;
  const log = options.log ?? console.log;
  const port = options.port ?? Number(env.FLARY_QUICKSTART_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("FLARY_QUICKSTART_PORT must be an integer from 1024 through 65535.");
  const origin = `http://${HOST}:${port}`;
  const callbackUrl = `${origin}/oauth/callback`;
  const configuredRedirect = env.FLARY_CLOUDFLARE_OAUTH_REDIRECT_URI;
  if (configuredRedirect && configuredRedirect !== callbackUrl) {
    throw new Error(`FLARY_CLOUDFLARE_OAUTH_REDIRECT_URI must be exactly ${callbackUrl}.`);
  }
  const session: SessionState = {
    id: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + SESSION_LIFETIME_MS,
  };
  const stateFile = join(target, ".flary", "quickstart.json");
  let record = await readSetupRecord(stateFile);
  let busy = false;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin);
      if (url.origin !== origin || request.headers.host !== `${HOST}:${port}`)
        return sendJson(response, 400, { error: "The setup host is invalid." });
      if (request.method === "GET" && url.pathname === "/") {
        setSecurityHeaders(response);
        // OAuth returns through a top-level cross-site navigation. Lax sends
        // the local HttpOnly cookie on that GET callback while Strict does
        // not. State and PKCE still bind the callback to this setup session.
        response.setHeader(
          "set-cookie",
          `flary_setup=${session.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_LIFETIME_MS / 1000}`,
        );
        return send(response, 200, "text/html; charset=utf-8", setupPageHtml);
      }
      if (request.method === "GET" && url.pathname === "/app.css")
        return sendAsset(response, "text/css; charset=utf-8", setupCss);
      if (request.method === "GET" && url.pathname === "/app.js")
        return sendAsset(response, "text/javascript; charset=utf-8", setupClientScript);
      if (request.method === "GET" && url.pathname === "/oauth/callback") {
        requireSession(request, session);
        if (url.searchParams.get("state") !== session.oauthState || !session.codeVerifier)
          throw new HttpError(
            400,
            "Cloudflare returned an invalid setup state. Start authorization again.",
          );
        if (url.searchParams.get("error"))
          throw new HttpError(
            400,
            `Cloudflare authorization stopped: ${url.searchParams.get("error_description") ?? url.searchParams.get("error")}`,
          );
        const code = url.searchParams.get("code");
        if (!code) throw new HttpError(400, "Cloudflare did not return an authorization code.");
        const clientId = env.FLARY_CLOUDFLARE_OAUTH_CLIENT_ID;
        if (!clientId)
          throw new HttpError(
            409,
            "No Cloudflare OAuth client is configured. Use the Wrangler login option.",
          );
        const token = await exchangeCloudflareCode({
          clientId,
          code,
          codeVerifier: session.codeVerifier,
          redirectUri: callbackUrl,
        });
        session.cloudflareAccessToken = token;
        session.oauthState = undefined;
        session.codeVerifier = undefined;
        session.accounts = await cloudflareAccounts(token);
        record = { ...record, version: 1, phase: "connected" };
        await writeSetupRecord(stateFile, record);
        response.statusCode = 303;
        response.setHeader("location", "/?connected=1");
        return response.end();
      }

      requireSession(request, session);
      if (request.method === "GET" && url.pathname === "/api/status") {
        const project = await readProject(target);
        return sendJson(
          response,
          200,
          publicStatus(record, project, session.accounts, {
            target,
            callbackUrl,
            oauthSupported: Boolean(env.FLARY_CLOUDFLARE_OAUTH_CLIENT_ID),
          }),
        );
      }
      requireMutation(request, origin);
      if (request.method === "POST" && url.pathname === "/api/cloudflare/oauth") {
        const clientId = env.FLARY_CLOUDFLARE_OAUTH_CLIENT_ID;
        if (!clientId)
          throw new HttpError(
            409,
            "A public Cloudflare OAuth client ID is not configured. Use Wrangler login.",
          );
        session.codeVerifier = randomBytes(64).toString("base64url");
        session.oauthState = randomBytes(32).toString("base64url");
        const challenge = createHash("sha256").update(session.codeVerifier).digest("base64url");
        const authorization = new URL("https://dash.cloudflare.com/oauth2/auth");
        authorization.searchParams.set("client_id", clientId);
        authorization.searchParams.set("redirect_uri", callbackUrl);
        authorization.searchParams.set("response_type", "code");
        authorization.searchParams.set(
          "scope",
          (env.FLARY_CLOUDFLARE_OAUTH_SCOPES?.split(/\s+/).filter(Boolean) ?? OAUTH_SCOPES).join(
            " ",
          ),
        );
        authorization.searchParams.set("state", session.oauthState);
        authorization.searchParams.set("code_challenge", challenge);
        authorization.searchParams.set("code_challenge_method", "S256");
        return sendJson(response, 200, { authorizationUrl: authorization.toString() });
      }
      if (request.method === "POST" && url.pathname === "/api/cloudflare/wrangler") {
        if (busy) throw new HttpError(409, "Another setup action is running.");
        busy = true;
        try {
          const login = await runner.run("npx", ["--yes", "wrangler@4", "login", "--use-keyring"], {
            cwd,
            env,
          });
          if (login.code !== 0)
            throw new HttpError(
              400,
              "Wrangler login did not finish. Run `npx wrangler login` in a terminal, then try again.",
            );
          const identity = await runner.run("npx", ["--yes", "wrangler@4", "whoami", "--json"], {
            cwd,
            env,
            quiet: true,
          });
          if (identity.code !== 0)
            throw new HttpError(400, "Wrangler login finished, but the account check failed.");
          session.accounts = parseWranglerAccounts(identity.stdout);
          record = { ...record, version: 1, phase: "connected" };
          await writeSetupRecord(stateFile, record);
          return sendJson(response, 200, { accounts: session.accounts });
        } finally {
          busy = false;
        }
      }
      if (request.method === "POST" && url.pathname === "/api/project") {
        const body = await readJson(request);
        const accountId = requiredString(body.accountId, "Cloudflare account");
        if (
          !session.accounts?.some((account) => account.id === accountId) &&
          record.accountId !== accountId
        )
          throw new HttpError(400, "Select a Cloudflare account that this setup can access.");
        const provider = providerValue(body.provider);
        const providerKey = typeof body.providerKey === "string" ? body.providerKey.trim() : "";
        if (
          ["google", "openai", "anthropic"].includes(provider) &&
          !providerKey &&
          !(await hasProviderKey(target, provider))
        ) {
          throw new HttpError(
            400,
            "Enter the provider key. The setup sends it only to the local server and stores it in the protected .dev.vars file.",
          );
        }
        const input = {
          target,
          accountId,
          workerName: requiredString(body.workerName, "Worker name"),
          agentName: requiredString(body.agentName, "Agent name"),
          systemPrompt: requiredString(body.systemPrompt, "System prompt"),
          provider,
          model: requiredString(body.model, "Exact model"),
          ...(providerKey ? { providerKey } : {}),
        };
        const project = await prepareQuickstartProject(input, {
          env,
          runner,
          log: (message) => log(message),
        });
        record = {
          version: 1,
          phase: "configured",
          accountId,
          workerName: project.workerName,
          agentName: input.agentName,
          systemPrompt: input.systemPrompt,
          provider,
          model: input.model,
          ...(record.deployedUrl ? { deployedUrl: record.deployedUrl } : {}),
        };
        await writeSetupRecord(stateFile, record);
        return sendJson(
          response,
          200,
          publicStatus(record, project, session.accounts, {
            target,
            callbackUrl,
            oauthSupported: Boolean(env.FLARY_CLOUDFLARE_OAUTH_CLIENT_ID),
          }),
        );
      }
      if (request.method === "POST" && url.pathname === "/api/deploy") {
        if (busy) throw new HttpError(409, "Another setup action is running.");
        if (!record.accountId)
          throw new HttpError(409, "Select an account and create the project first.");
        busy = true;
        try {
          const deployed = await deployQuickstartProject(
            target,
            {
              accountId: record.accountId,
              ...(session.cloudflareAccessToken
                ? { cloudflareAccessToken: session.cloudflareAccessToken }
                : {}),
            },
            { env, runner, log },
          );
          record = {
            ...record,
            phase: "deployed",
            ...(deployed.deployedUrl ? { deployedUrl: deployed.deployedUrl } : {}),
          };
          await writeSetupRecord(stateFile, record);
          return sendJson(
            response,
            200,
            publicStatus(record, deployed, session.accounts, {
              target,
              callbackUrl,
              oauthSupported: Boolean(env.FLARY_CLOUDFLARE_OAUTH_CLIENT_ID),
            }),
          );
        } catch (error) {
          throw new HttpError(400, recoveryMessage(error));
        } finally {
          busy = false;
        }
      }
      if (request.method === "POST" && url.pathname === "/api/finish") {
        response.setHeader("set-cookie", "flary_setup=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
        return sendJson(response, 200, { ok: true });
      }
      return sendJson(response, 404, { error: "The setup route was not found." });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "The setup action failed.";
      return sendJson(response, status, { error: message });
    }
  });

  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => accept());
  }).catch((error) => {
    throw new Error(
      `The quick start cannot listen on ${origin}. Stop the process that uses this port or set FLARY_QUICKSTART_PORT and register the exact OAuth redirect URI. ${error instanceof Error ? error.message : ""}`,
    );
  });
  log(`Flary quick start: ${origin}`);
  log(`Project directory: ${target}`);
  if (options.openBrowser !== false) void openUrl(origin);
  return {
    url: origin,
    close: () =>
      new Promise((accept, reject) => server.close((error) => (error ? reject(error) : accept()))),
  };
}

export async function runQuickstart(options: QuickstartServerOptions = {}): Promise<void> {
  const server = await startQuickstartServer(options);
  await new Promise<void>((accept) => {
    const stop = () => {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      accept();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  });
  await server.close();
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function requireSession(request: IncomingMessage, session: SessionState): void {
  if (Date.now() > session.expiresAt)
    throw new HttpError(401, "The setup session expired. Restart `flary quickstart`.");
  const cookies = request.headers.cookie?.split(";").map((value) => value.trim()) ?? [];
  if (!cookies.includes(`flary_setup=${session.id}`))
    throw new HttpError(401, "The setup session is invalid. Reload the local setup page.");
}

function requireMutation(request: IncomingMessage, origin: string): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  if (request.headers.origin !== origin)
    throw new HttpError(403, "The setup request origin is invalid.");
  if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json")
    throw new HttpError(415, "The setup request must use JSON.");
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let value = "";
  for await (const chunk of request) {
    value += chunk.toString();
    if (value.length > 64 * 1024) throw new HttpError(413, "The setup request is too large.");
  }
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "The setup request is not valid JSON.");
  }
}

async function exchangeCloudflareCode(input: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<string> {
  const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== "string")
    throw new HttpError(
      400,
      "Cloudflare did not issue an access token. Check the OAuth client scopes and exact redirect URI.",
    );
  return body.access_token;
}

async function cloudflareAccounts(token: string): Promise<Array<{ id: string; name: string }>> {
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=100", {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const result = Array.isArray(body.result) ? body.result : [];
  if (!response.ok)
    throw new HttpError(
      400,
      "Cloudflare authorization succeeded, but the account list is not available. Check the account.read scope.",
    );
  return result.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const account = item as Record<string, unknown>;
    return typeof account.id === "string"
      ? [{ id: account.id, name: typeof account.name === "string" ? account.name : account.id }]
      : [];
  });
}

function publicStatus(
  record: SetupRecord,
  project: FlaryProjectState | undefined,
  accounts: SessionState["accounts"],
  local: { target: string; callbackUrl: string; oauthSupported: boolean },
) {
  const deployedUrl = project?.deployedUrl ?? record.deployedUrl;
  return {
    phase: record.phase,
    target: local.target,
    oauthSupported: local.oauthSupported,
    callbackUrl: local.callbackUrl,
    accounts:
      accounts ?? (record.accountId ? [{ id: record.accountId, name: record.accountId }] : []),
    config: {
      accountId: project?.accountId ?? record.accountId ?? "",
      workerName: project?.workerName ?? record.workerName ?? "flary-widget",
      agentName: record.agentName ?? "Support assistant",
      systemPrompt:
        record.systemPrompt ??
        "Help visitors use this product. Give short and accurate answers. Say when you do not know.",
      provider: project?.provider ?? record.provider ?? "google",
      model: project?.model ?? record.model ?? "gemini-2.5-flash",
      hasProviderKey: Boolean(project?.requiredSecrets.some((name) => name.endsWith("API_KEY"))),
    },
    ...(deployedUrl
      ? {
          deployedUrl,
          widgetUrl: `${deployedUrl}/widget`,
          embedCode: `<flary-chat title=${JSON.stringify(record.agentName ?? "Support assistant")}></flary-chat>\n<script src=${JSON.stringify(`${deployedUrl}/widget.js`)}></script>`,
          reactExample: join(local.target, "examples", "FlaryChat.tsx"),
        }
      : {}),
  };
}

async function readSetupRecord(file: string): Promise<SetupRecord> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as SetupRecord;
  } catch {
    return { version: 1, phase: "welcome" };
  }
}

async function readProject(target: string): Promise<FlaryProjectState | undefined> {
  try {
    return JSON.parse(
      await readFile(join(target, ".flary", "project.json"), "utf8"),
    ) as FlaryProjectState;
  } catch {
    return undefined;
  }
}

async function writeSetupRecord(file: string, record: SetupRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

async function hasProviderKey(target: string, provider: Provider): Promise<boolean> {
  const name =
    provider === "google"
      ? "GEMINI_API_KEY"
      : provider === "openai"
        ? "OPENAI_API_KEY"
        : "ANTHROPIC_API_KEY";
  try {
    return new RegExp(`^${name}=`, "m").test(await readFile(join(target, ".dev.vars"), "utf8"));
  } catch {
    return false;
  }
}

function providerValue(value: unknown): Provider {
  if (value === "google" || value === "openai" || value === "anthropic" || value === "workers-ai")
    return value;
  throw new HttpError(400, "Select a supported model provider.");
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${label} is required.`);
  return value.trim();
}

function recoveryMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Deployment failed.";
  if (/paid|plan|entitlement|not available/i.test(message))
    return `${message} Remove unsupported features or upgrade the Cloudflare Workers plan, then select Deploy again.`;
  if (/d1/i.test(message))
    return `${message} Open Cloudflare D1 for this account, confirm that D1 is available, then select Deploy again. The deployment is safe to repeat.`;
  if (/r2/i.test(message))
    return `${message} Enable R2 for this account, then select Deploy again. The deployment is safe to repeat.`;
  if (/queue/i.test(message))
    return `${message} Enable Workers Queues for this account, then select Deploy again. The deployment is safe to repeat.`;
  if (/permission|unauthorized|forbidden|scope/i.test(message))
    return `${message} Authorize again with Workers Platform Read and Write access, or run \`npx wrangler login\` in a terminal.`;
  return `${message} Fix the reported item, then select Deploy again. Flary reuses existing resources when it can.`;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function sendAsset(response: ServerResponse, type: string, body: string): void {
  setSecurityHeaders(response);
  send(response, 200, type, body);
}
function sendJson(response: ServerResponse, status: number, value: unknown): void {
  setSecurityHeaders(response);
  send(response, status, "application/json; charset=utf-8", JSON.stringify(value));
}
function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.statusCode = status;
  response.setHeader("content-type", type);
  response.end(body);
}

const commandRunner: CommandRunner = {
  run(command, args, options) {
    return new Promise((accept, reject) => {
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
      child.once("close", (code) => accept({ code: code ?? 1, stdout, stderr }));
    });
  },
};

async function openUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
}

const setupHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flary quick start</title><link rel="stylesheet" href="/app.css"></head><body><main class="shell"><aside><a class="mark" href="#welcome" aria-label="Flary home"><span>f</span> Flary</a><p class="eyebrow">Local setup</p><ol id="steps"><li class="active">Welcome</li><li>Cloudflare</li><li>Worker</li><li>Agent</li><li>Model</li><li>Preview</li><li>Deploy</li></ol><p class="local">Runs on 127.0.0.1<br>No hosted credential service</p></aside><section class="stage"><div id="notice" role="status"></div><form id="wizard"><section class="panel active" data-step="0"><p class="eyebrow">Ready for takeoff</p><h1>Your first Flary agent,<br>in your Cloudflare account.</h1><p class="lead">This setup creates one Worker, durable agent storage, D1, R2, Queues, Worker secrets, and a chat widget that you can add to your app.</p><div class="manifest"><span>Will create</span><b>Worker + Durable Objects</b><b>D1 + R2 + Queues</b><b>Gemini secret + widget files</b></div><button type="button" data-next>Review Cloudflare access</button></section><section class="panel" data-step="1"><p class="eyebrow">Cloudflare access</p><h2>Connect your account</h2><p>Flary asks for Account Read and Workers Platform Read and Write. It uses this access to list your accounts and create only the resources shown here. You can revoke access in Cloudflare.</p><div class="permission"><b>Account Read</b><span>List accounts that you can select.</span></div><div class="permission"><b>Workers Platform Write</b><span>Create and update the Worker, Durable Objects, D1, R2, Queues, and secrets.</span></div><button type="button" id="oauth">Authorize with Cloudflare</button><button type="button" class="secondary" id="wrangler">Use Wrangler OAuth</button><p id="oauth-note" class="note"></p><button type="button" class="text" data-next>Continue after connection</button></section><section class="panel" data-step="2"><p class="eyebrow">Destination</p><h2>Choose the account and Worker</h2><label>Cloudflare account<select name="accountId" id="account" required></select></label><label>Worker name<input name="workerName" value="flary-widget" pattern="[a-z0-9-]+" maxlength="63" required><small>Use lowercase letters, numbers, and hyphens.</small></label><div class="actions"><button type="button" class="secondary" data-back>Back</button><button type="button" data-next>Set up the agent</button></div></section><section class="panel" data-step="3"><p class="eyebrow">Agent</p><h2>Give the widget a clear job</h2><label>Agent name<input name="agentName" value="Support assistant" required></label><label>System prompt<textarea name="systemPrompt" rows="8" required>Help visitors use this product. Give short and accurate answers. Say when you do not know.</textarea></label><div class="actions"><button type="button" class="secondary" data-back>Back</button><button type="button" data-next>Choose a model</button></div></section><section class="panel" data-step="4"><p class="eyebrow">Model</p><h2>Select the provider and exact model</h2><label>Provider<select name="provider" id="provider"><option value="google">Google Gemini</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="workers-ai">Cloudflare Workers AI</option></select></label><label>Exact model<input name="model" id="model" value="gemini-2.5-flash" required></label><label id="key-label">Google Gemini API key<input name="providerKey" id="provider-key" type="password" autocomplete="off" spellcheck="false"><small>The key goes to this local process. It never enters browser storage, a URL, a log, public code, or model context.</small></label><div class="actions"><button type="button" class="secondary" data-back>Back</button><button type="button" id="create">Create local project</button></div></section><section class="panel" data-step="5"><p class="eyebrow">Local preview</p><h2>Test the widget style</h2><div class="preview"><div class="chat"><header><b id="preview-title">Support assistant</b><small>Local preview</small></header><div id="messages"><p>How can I help?</p></div><div class="composer"><input id="preview-input" placeholder="Write a test message"><button type="button" id="preview-send">Send</button></div></div><div><h3>Your project is ready</h3><p id="project-path"></p><p>This preview checks the widget interaction and style. Deployment sends the first live model test.</p></div></div><div class="actions"><button type="button" class="secondary" data-back>Back</button><button type="button" data-next>Review deployment</button></div></section><section class="panel" data-step="6"><p class="eyebrow">Deployment</p><h2>Create resources and verify</h2><p>Flary builds the project, provisions missing resources, uploads Worker secrets, applies migrations, checks health, and sends one test message. You can repeat this action safely after an interruption.</p><div class="manifest"><span>In your account</span><b>Worker and Durable Objects</b><b>D1, R2, and Queues</b><b>Protected Worker secrets</b></div><button type="button" id="deploy">Deploy and verify</button><div id="result" hidden><h3>Deployment is ready</h3><a id="widget-link" target="_blank" rel="noreferrer">Open the live widget</a><label>HTML embed<textarea id="embed" rows="4" readonly></textarea></label><button type="button" class="secondary" id="copy">Copy embed code</button><p id="react-path"></p></div><button type="button" class="text" data-back>Back</button></section></form></section></main><script src="/app.js"></script></body></html>`;

const setupCss = `:root{--ink:#14231e;--muted:#637069;--paper:#f5f8f7;--white:#fff;--fern:#176b52;--fern2:#0e4938;--line:#d7e1dd;--sky:#d9eaf4;--warn:#8b2e21;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:var(--ink);background:var(--paper)}*{box-sizing:border-box}body{margin:0}.shell{min-height:100vh;display:grid;grid-template-columns:17rem 1fr}aside{position:relative;padding:2rem;background:var(--ink);color:#dce8e3}.mark{color:#fff;text-decoration:none;font-size:1.15rem;font-weight:800;letter-spacing:.02em}.mark span{display:inline-grid;place-items:center;width:2rem;height:2rem;margin-right:.45rem;border-radius:50% 50% 50% 12%;background:#77c7ab;color:var(--ink);font:900 1.25rem Georgia,serif}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font:700 .7rem ui-monospace,monospace;color:var(--fern)}aside .eyebrow{margin-top:4rem;color:#8cccb5}ol{list-style:none;margin:1.5rem 0;padding:0;border-left:1px solid #ffffff30}li{position:relative;padding:.55rem 0 .55rem 1.25rem;color:#8da099;font-size:.84rem}li:before{content:'';position:absolute;left:-4px;top:1rem;width:7px;height:7px;border-radius:50%;background:#60736b}li.active{color:#fff;font-weight:700}li.active:before{background:#85d8ba;box-shadow:0 0 0 5px #85d8ba22}.local{position:absolute;bottom:1.5rem;font:500 .7rem/1.7 ui-monospace,monospace;color:#8da099}.stage{display:grid;place-items:center;padding:4rem 6vw}.panel{display:none;width:min(48rem,100%)}.panel.active{display:block;animation:arrive .3s ease-out}@keyframes arrive{from{opacity:0;transform:translateY(7px)}}h1{font:700 clamp(2.6rem,6vw,5.4rem)/.95 ui-rounded,"Arial Rounded MT Bold",sans-serif;letter-spacing:-.065em;margin:.4rem 0 1.5rem;max-width:14ch}h2{font:700 clamp(2rem,4vw,3.6rem)/1 ui-rounded,"Arial Rounded MT Bold",sans-serif;letter-spacing:-.045em;margin:.4rem 0 1.5rem}h3{margin-top:0}.lead{font-size:1.15rem;line-height:1.65;max-width:42rem;color:var(--muted)}.manifest{display:grid;grid-template-columns:8rem 1fr;margin:2rem 0;border-top:1px solid var(--line)}.manifest>*{padding:.85rem 0;border-bottom:1px solid var(--line)}.manifest span{grid-row:span 3;color:var(--muted);font:700 .68rem ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em}.manifest b{font-size:.9rem}.permission{display:grid;grid-template-columns:13rem 1fr;gap:1rem;border-top:1px solid var(--line);padding:1rem 0}.permission:last-of-type{border-bottom:1px solid var(--line);margin-bottom:1.5rem}.permission span,.note,small{color:var(--muted)}label{display:block;margin:1.2rem 0;font-weight:700}input,select,textarea{display:block;width:100%;margin-top:.45rem;padding:.85rem 1rem;border:1px solid var(--line);border-radius:10px;background:var(--white);color:var(--ink);font:inherit}textarea{resize:vertical}input:focus,select:focus,textarea:focus,button:focus-visible,a:focus-visible{outline:3px solid #48a98755;outline-offset:2px}button{border:0;border-radius:10px;padding:.82rem 1.05rem;background:var(--fern);color:#fff;font:800 .88rem/1 inherit;cursor:pointer;margin:.35rem .35rem .35rem 0}button:hover{background:var(--fern2)}button:disabled{opacity:.55;cursor:wait}.secondary{background:var(--white);border:1px solid var(--line);color:var(--ink)}.secondary:hover{background:#eaf0ed}.text{background:transparent;color:var(--fern);padding-left:.2rem}.text:hover{background:transparent;text-decoration:underline}.actions{display:flex;justify-content:space-between;margin-top:1.5rem}.preview{display:grid;grid-template-columns:minmax(18rem,24rem) 1fr;gap:2.5rem;align-items:center}.chat{height:31rem;border:1px solid var(--line);border-radius:20px;background:#eef3f1;display:grid;grid-template-rows:auto 1fr auto;overflow:hidden;box-shadow:0 20px 60px #14231e18}.chat header{padding:1rem;background:#fff;border-bottom:1px solid var(--line)}.chat header small{display:block}.chat #messages{padding:1rem;overflow:auto}.chat #messages p{width:max-content;max-width:85%;padding:.7rem .85rem;background:#fff;border:1px solid var(--line);border-radius:13px}.chat #messages p.user{margin-left:auto;background:var(--fern);color:#fff}.composer{display:grid;grid-template-columns:1fr auto;gap:.4rem;padding:.6rem;background:#fff;border-top:1px solid var(--line)}.composer input,.composer button{margin:0}#notice{position:fixed;right:1.5rem;top:1.5rem;max-width:34rem;z-index:3;padding:.8rem 1rem;border-radius:10px;background:var(--ink);color:#fff;opacity:0;pointer-events:none;transition:opacity .2s}#notice.show{opacity:1}#notice.error{background:var(--warn)}#result{margin-top:1.5rem;padding:1.2rem;border:1px solid var(--line);border-radius:14px;background:var(--sky)}#widget-link{color:var(--fern2);font-weight:800}@media(max-width:760px){.shell{display:block}aside{padding:1rem 1.2rem}aside .eyebrow,aside ol,.local{display:none}.stage{padding:2rem 1.2rem}.preview{grid-template-columns:1fr}.chat{height:28rem}.permission{grid-template-columns:1fr}.actions{gap:.5rem}h1{font-size:3rem}}@media(prefers-reduced-motion:reduce){.panel.active{animation:none}}`;

const setupScript = `let step=0;let status;const panels=[...document.querySelectorAll('.panel')];const items=[...document.querySelectorAll('#steps li')];const form=document.querySelector('#wizard');function show(index){step=Math.max(0,Math.min(index,panels.length-1));panels.forEach((panel,i)=>panel.classList.toggle('active',i===step));items.forEach((item,i)=>item.classList.toggle('active',i===step));window.scrollTo(0,0)}function notice(message,error=false){const node=document.querySelector('#notice');node.textContent=message;node.className='show'+(error?' error':'');clearTimeout(notice.timer);notice.timer=setTimeout(()=>node.className='',6000)}async function api(path,body={}){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw new Error(value.error||'The setup action failed.');return value}async function load(){const response=await fetch('/api/status');status=await response.json();const config=status.config;for(const [name,value] of Object.entries(config)){const field=form.elements.namedItem(name);if(field&&typeof value==='string'&&value)field.value=value}document.querySelector('#project-path').textContent=status.target;document.querySelector('#oauth-note').textContent=status.oauthSupported?'Uses Authorization Code with PKCE (S256). Callback: '+status.callbackUrl:'This package has no public OAuth client ID. Wrangler OAuth is the safest supported fallback. It keeps Cloudflare credentials in Wrangler or the operating system keychain.';renderAccounts();renderResult();if(status.phase==='connected')show(2);if(status.phase==='configured')show(5);if(status.phase==='deployed')show(6)}function renderAccounts(){const select=document.querySelector('#account');select.replaceChildren();for(const account of status.accounts||[]){const option=document.createElement('option');option.value=account.id;option.textContent=account.name;select.append(option)}if(status.config.accountId)select.value=status.config.accountId}function renderResult(){if(!status.deployedUrl)return;const result=document.querySelector('#result');result.hidden=false;const link=document.querySelector('#widget-link');link.href=status.widgetUrl;document.querySelector('#embed').value=status.embedCode;document.querySelector('#react-path').textContent='React example: '+status.reactExample}document.querySelectorAll('[data-next]').forEach(button=>button.addEventListener('click',()=>show(step+1)));document.querySelectorAll('[data-back]').forEach(button=>button.addEventListener('click',()=>show(step-1)));document.querySelector('#oauth').addEventListener('click',async()=>{try{const value=await api('/api/cloudflare/oauth');location.href=value.authorizationUrl}catch(error){notice(error.message,true)}});document.querySelector('#wrangler').addEventListener('click',async(event)=>{const button=event.currentTarget;button.disabled=true;button.textContent='Finish authorization in the browser…';try{const value=await api('/api/cloudflare/wrangler');status.accounts=value.accounts;renderAccounts();notice('Cloudflare is connected.');show(2)}catch(error){notice(error.message,true)}finally{button.disabled=false;button.textContent='Use Wrangler OAuth'}});const provider=document.querySelector('#provider');provider.addEventListener('change',()=>{const values={google:['gemini-2.5-flash','Google Gemini API key'],openai:['gpt-5','OpenAI API key'],anthropic:['claude-sonnet-4-5','Anthropic API key'],'workers-ai':['@cf/meta/llama-3.3-70b-instruct-fp8-fast','No provider key is needed']};const next=values[provider.value];document.querySelector('#model').value=next[0];document.querySelector('#key-label').firstChild.textContent=next[1];document.querySelector('#provider-key').hidden=provider.value==='workers-ai'});document.querySelector('#create').addEventListener('click',async(event)=>{const button=event.currentTarget;button.disabled=true;button.textContent='Creating project…';try{const data=Object.fromEntries(new FormData(form));status=await api('/api/project',data);document.querySelector('#preview-title').textContent=data.agentName;document.querySelector('#project-path').textContent=status.target;notice('The local project is ready.');show(5)}catch(error){notice(error.message,true)}finally{button.disabled=false;button.textContent='Create local project'}});document.querySelector('#preview-send').addEventListener('click',()=>{const input=document.querySelector('#preview-input');if(!input.value.trim())return;const messages=document.querySelector('#messages');const user=document.createElement('p');user.className='user';user.textContent=input.value.trim();messages.append(user);input.value='';setTimeout(()=>{const reply=document.createElement('p');reply.textContent='The widget is ready. Deployment will test the selected model.';messages.append(reply);reply.scrollIntoView({block:'end'})},250)});document.querySelector('#deploy').addEventListener('click',async(event)=>{const button=event.currentTarget;button.disabled=true;button.textContent='Provisioning and verifying…';try{status=await api('/api/deploy');renderResult();notice('Deployment is healthy and the first test passed.')}catch(error){notice(error.message,true)}finally{button.disabled=false;button.textContent='Deploy and verify'}});document.querySelector('#copy').addEventListener('click',async()=>{await navigator.clipboard.writeText(document.querySelector('#embed').value);notice('Embed code copied.')});load().catch(error=>notice(error.message,true));`;

const setupPageHtml = setupHtml.replace(
  'class="text" data-next>Continue after connection',
  'class="text" id="cloudflare-next" data-next disabled>Continue after connection',
);
const setupClientScript = setupScript
  .replace(
    "status=await response.json();const config=status.config;",
    "status=await response.json();document.querySelector('#oauth').disabled=!status.oauthSupported;const config=status.config;",
  )
  .replace(
    "if(status.config.accountId)select.value=status.config.accountId}",
    "if(status.config.accountId)select.value=status.config.accountId;document.querySelector('#cloudflare-next').disabled=!(status.accounts||[]).length}",
  );
