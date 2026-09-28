import { setupHtml, setupCss, setupScript } from "./quickstart-ui.js";
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
  readonly step?: number;
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
  let lastError: string | undefined;
  let progress = { stage: "idle", message: "Ready when you are." };
  const reportProgress = (stage: string, message: string) => {
    progress = { stage, message };
  };
  const currentStatus = async () => {
    const project = await readProject(target);
    const value = publicStatus(record, project, session.accounts, {
      target,
      callbackUrl,
      oauthSupported: Boolean(env.FLARY_CLOUDFLARE_OAUTH_CLIENT_ID),
    });
    return {
      ...value,
      busy,
      cloudflareConnected: Boolean(session.accounts?.length),
      progress,
      ...(lastError ? { error: lastError } : {}),
      config: {
        ...value.config,
        hasProviderKey: await hasProviderKey(target, value.config.provider),
      },
    };
  };

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
        return send(response, 200, "text/html; charset=utf-8", setupHtml);
      }
      if (request.method === "GET" && url.pathname === "/app.css")
        return sendAsset(response, "text/css; charset=utf-8", setupCss);
      if (request.method === "GET" && url.pathname === "/app.js")
        return sendAsset(response, "text/javascript; charset=utf-8", setupScript);
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
        return sendJson(response, 200, await currentStatus());
      }
      requireMutation(request, origin);
      if (!busy && url.pathname !== "/api/draft") lastError = undefined;
      if (request.method === "POST" && url.pathname === "/api/draft") {
        if (busy) throw new HttpError(409, "Another setup action is running.");
        const body = await readJson(request);
        const draft: Record<string, string> = {};
        for (const [name, limit] of Object.entries({
          agentName: 120,
          systemPrompt: 12000,
          workerName: 63,
          model: 200,
          accountId: 100,
        })) {
          if (typeof body[name] === "string") {
            if (body[name].length > limit) throw new HttpError(400, `${name} is too long.`);
            draft[name] = body[name];
          }
        }
        if (
          draft.accountId &&
          draft.accountId !== record.accountId &&
          !session.accounts?.some((account) => account.id === draft.accountId)
        )
          throw new HttpError(400, "Connect your Cloudflare account before selecting it.");
        if (!draft.accountId) delete draft.accountId;
        const provider =
          body.provider === undefined ? record.provider : providerValue(body.provider);
        const changed =
          Object.entries(draft).some(
            ([key, value]) => record[key as keyof SetupRecord] !== value,
          ) || provider !== record.provider;
        const step =
          typeof body.step === "number" &&
          Number.isInteger(body.step) &&
          body.step >= 0 &&
          body.step <= 2
            ? body.step
            : record.step;
        record = {
          ...record,
          ...draft,
          ...(step === undefined ? {} : { step }),
          ...(provider ? { provider } : {}),
          ...(changed && record.phase !== "welcome" ? { phase: "connected" as const } : {}),
        };
        await writeSetupRecord(stateFile, record);
        return sendJson(response, 200, await currentStatus());
      }
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
      if (
        request.method === "POST" &&
        (url.pathname === "/api/cloudflare/wrangler" || url.pathname === "/api/cloudflare/check")
      ) {
        if (busy) throw new HttpError(409, "Another setup action is running.");
        busy = true;
        try {
          const check = () =>
            runner.run("npx", ["--yes", "wrangler@4", "whoami", "--json"], {
              cwd,
              env,
              quiet: true,
            });
          let identity = await check();
          if (identity.code !== 0 && url.pathname === "/api/cloudflare/wrangler") {
            reportProgress("account", "Finish connecting in the Cloudflare browser tab…");
            const login = await runner.run(
              "npx",
              ["--yes", "wrangler@4", "login", "--use-keyring"],
              { cwd, env },
            );
            if (login.code !== 0)
              throw new HttpError(
                400,
                "Cloudflare sign-in did not finish. Return to setup and try connecting again.",
              );
            identity = await check();
          }
          if (identity.code !== 0) {
            session.accounts = undefined;
            if (url.pathname === "/api/cloudflare/wrangler")
              throw new HttpError(
                400,
                "Sign-in finished, but account access could not be verified. Try connecting again.",
              );
          } else {
            session.accounts = parseWranglerAccounts(identity.stdout);
            if (!session.accounts.length)
              throw new HttpError(
                400,
                "Signed in, but no Cloudflare accounts are available. Check your account membership and try again.",
              );
            if (url.pathname === "/api/cloudflare/wrangler") {
              record = {
                ...record,
                version: 1,
                ...(record.phase === "welcome" ? { phase: "connected" as const } : {}),
              };
              await writeSetupRecord(stateFile, record);
            }
          }
          busy = false;
          return sendJson(response, 200, await currentStatus());
        } finally {
          busy = false;
        }
      }
      if (request.method === "POST" && url.pathname === "/api/project") {
        if (busy) throw new HttpError(409, "Another setup action is running.");
        busy = true;
        reportProgress("prepare", "Creating your project and installing dependencies…");
        try {
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
          busy = false;
          reportProgress("prepared", "Your project is ready to launch.");
          return sendJson(response, 200, await currentStatus());
        } finally {
          busy = false;
        }
      }
      if (request.method === "POST" && url.pathname === "/api/deploy") {
        if (busy) throw new HttpError(409, "Another setup action is running.");
        if (!record.accountId || record.phase === "welcome" || record.phase === "connected")
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
            { env, runner, log, progress: reportProgress },
          );
          record = {
            ...record,
            phase: "deployed",
            ...(deployed.deployedUrl ? { deployedUrl: deployed.deployedUrl } : {}),
          };
          await writeSetupRecord(stateFile, record);
          busy = false;
          reportProgress("complete", "Your assistant is live and the response test passed.");
          return sendJson(response, 200, await currentStatus());
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
      if (!busy) reportProgress("error", "Setup needs your attention. Review the error and retry.");
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "The setup action failed.";
      if (!busy && status !== 403 && status !== 401) lastError = message;
      if (
        request.method === "GET" &&
        request.url?.startsWith("/oauth/callback") &&
        status !== 401
      ) {
        response.statusCode = 303;
        response.setHeader("location", "/");
        return response.end();
      }
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
    step: record.step ?? 0,
    target: local.target,
    oauthSupported: local.oauthSupported,
    callbackUrl: local.callbackUrl,
    accounts:
      accounts ?? (record.accountId ? [{ id: record.accountId, name: record.accountId }] : []),
    config: {
      accountId: record.accountId ?? project?.accountId ?? "",
      workerName: record.workerName ?? project?.workerName ?? "flary-widget",
      agentName: record.agentName ?? "Support assistant",
      systemPrompt:
        record.systemPrompt ??
        "Help visitors use this product. Give short and accurate answers. Say when you do not know.",
      provider: record.provider ?? project?.provider ?? "google",
      model: record.model ?? project?.model ?? "gemini-2.5-flash",
      hasProviderKey: Boolean(project?.requiredSecrets.some((name) => name.endsWith("API_KEY"))),
    },
    ...(deployedUrl && record.phase === "deployed"
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
    return `${message} Remove unsupported features or upgrade the Cloudflare Workers plan, then select Launch assistant again.`;
  if (/d1/i.test(message))
    return `${message} Open Cloudflare D1 for this account, confirm that D1 is available, then select Launch assistant again. The deployment is safe to repeat.`;
  if (/r2/i.test(message))
    return `${message} Enable R2 for this account, then select Launch assistant again. The deployment is safe to repeat.`;
  if (/queue/i.test(message))
    return `${message} Enable Workers Queues for this account, then select Launch assistant again. The deployment is safe to repeat.`;
  if (/permission|unauthorized|forbidden|scope/i.test(message))
    return `${message} Authorize again with Workers Platform Read and Write access, or run \`npx wrangler login\` in a terminal.`;
  return `${message} Fix the reported item, then select Launch assistant again. Flary reuses existing resources when it can.`;
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
