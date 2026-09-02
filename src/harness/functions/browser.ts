import type { Browser, BrowserContext, Page } from "@cloudflare/playwright";

import type { FlaryBrowserSource, FlaryStepContext, FlaryToolConnection } from "./types.js";
import { parseThreadName } from "../storage/scopes.js";
import { createCloudflareWorkspaceConnection } from "../cloudflare/workspace.js";

interface BrowserSql {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
}

interface BrowserStateBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: Uint8Array, options?: unknown): Promise<unknown>;
  delete?(key: string): Promise<void>;
}

/** Build the trusted Browser Run connection used by one Code Mode execution. */
export async function createCloudflareBrowserConnection<TBindings>(
  source: FlaryBrowserSource,
  input: {
    readonly bindings: TBindings;
    readonly context: FlaryStepContext<TBindings>;
    readonly storage?: unknown;
  },
): Promise<FlaryToolConnection> {
  const bindings = record(input.bindings);
  const bindingName = source.options.binding ?? "BROWSER";
  const endpoint = bindings[bindingName];
  if (!endpoint) {
    throw new Error(`app.browser() needs the '${bindingName}' Browser Run binding`);
  }
  const sql = browserSql(input.storage);
  sql?.exec(`
    CREATE TABLE IF NOT EXISTS flary_browser_sessions (
      profile_key TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const profileKey =
    source.options.profile === "ephemeral"
      ? `ephemeral:${crypto.randomUUID()}`
      : `thread:${input.context.runId ?? "default"}`;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  const consoleEntries: Array<Record<string, unknown>> = [];
  const networkEntries: Array<Record<string, unknown>> = [];
  const stateStore =
    source.options.profile === "ephemeral"
      ? undefined
      : browserStateStore(bindings, input.context.runId);

  const activePage = async (): Promise<Page> => {
    if (page && !page.isClosed()) return page;
    const playwright = await import("@cloudflare/playwright");
    const saved = sql
      ?.exec<{ session_id: string }>(
        "SELECT session_id FROM flary_browser_sessions WHERE profile_key = ?",
        profileKey,
      )
      .toArray()[0];
    try {
      browser = saved ? await playwright.connect(endpoint as never, saved.session_id) : undefined;
    } catch {
      browser = undefined;
    }
    if (!browser) {
      const acquired = await playwright.acquire(endpoint as never, {
        keep_alive: boundedKeepAlive(source.options.keepAliveMs),
      });
      browser = await playwright.connect(endpoint as never, acquired.sessionId);
      sql?.exec(
        `INSERT INTO flary_browser_sessions (profile_key, session_id, state, updated_at)
         VALUES (?, ?, 'agent', ?)
         ON CONFLICT(profile_key) DO UPDATE SET
           session_id = excluded.session_id,
           state = excluded.state,
           updated_at = excluded.updated_at`,
        profileKey,
        acquired.sessionId,
        new Date().toISOString(),
      );
      await registerBrowserSession(bindings, input.context.runId, acquired.sessionId);
    }
    const restoredState = browser.contexts().length === 0 ? await stateStore?.load() : undefined;
    context =
      browser.contexts()[0] ??
      (await browser.newContext(restoredState ? { storageState: restoredState } : undefined));
    page = context.pages()[0] ?? (await context.newPage());
    page.on("console", (message) => {
      consoleEntries.push({
        type: message.type(),
        text: message.text().slice(0, 16_384),
        occurredAt: new Date().toISOString(),
      });
      if (consoleEntries.length > 200) consoleEntries.shift();
    });
    page.on("request", (request) => {
      let url = "[blocked or non-HTTP URL]";
      try {
        url = assertPublicBrowserUrl(request.url()).toString();
      } catch {
        // Page-owned subresource URLs are untrusted. Keep the audit callback
        // bounded and do not let a data:, blob:, or private URL throw here.
      }
      networkEntries.push({
        method: request.method(),
        url,
        resourceType: request.resourceType(),
        occurredAt: new Date().toISOString(),
      });
      if (networkEntries.length > 500) networkEntries.shift();
    });
    return page;
  };
  const saveState = async (): Promise<void> => {
    if (stateStore && context) await stateStore.save(await context.storageState());
  };

  const descriptors: FlaryToolConnection["descriptors"] = [
    descriptor("navigate", "Open a public URL", true, ["url"]),
    descriptor("back", "Go to the previous page", true),
    descriptor("forward", "Go to the next page", true),
    descriptor("reload", "Reload the current page", true),
    descriptor("snapshot", "Read an accessibility snapshot and page metadata", false),
    descriptor("click", "Click one page element", true, ["selector"]),
    descriptor("type", "Enter text into one page element", true, ["selector", "text"]),
    descriptor("select", "Select a value in one page element", true, ["selector", "value"]),
    descriptor("scroll", "Scroll the current page", true),
    descriptor("wait", "Wait for an element or a bounded time", false),
    descriptor("screenshot", "Capture the current page as base64 PNG", false),
    descriptor("download", "Download one file into the durable workspace", true, ["selector"]),
    descriptor("console", "Read bounded browser console entries", false),
    descriptor("network", "Read bounded browser request entries", false),
    descriptor("evaluate", "Run bounded JavaScript in the page", true, ["expression"]),
    descriptor("status", "Read Browser Run session status", false),
    descriptor("close", "Close the Browser Run session", true),
  ];

  return {
    descriptors,
    async call(name, value) {
      const args = record(value);
      if (name !== "status") {
        await assertAgentBrowserControl(bindings, input.context.runId);
      }
      const current = await activePage();
      if (name === "navigate") {
        const url = assertPublicBrowserUrl(String(args.url ?? ""));
        const response = await current.goto(url.toString(), {
          waitUntil: "domcontentloaded",
          timeout: boundedTimeout(args.timeoutMs),
        });
        await saveState();
        return { url: current.url(), status: response?.status(), title: await current.title() };
      }
      if (name === "back" || name === "forward" || name === "reload") {
        const response =
          name === "back"
            ? await current.goBack()
            : name === "forward"
              ? await current.goForward()
              : await current.reload();
        await saveState();
        return { url: current.url(), status: response?.status(), title: await current.title() };
      }
      if (name === "snapshot") {
        const body = current.locator("body");
        const snapshot =
          "ariaSnapshot" in body && typeof body.ariaSnapshot === "function"
            ? await body.ariaSnapshot({ timeout: boundedTimeout(args.timeoutMs) })
            : (await body.innerText()).slice(0, 200_000);
        return { url: current.url(), title: await current.title(), snapshot };
      }
      if (name === "click") {
        await current.locator(requiredString(args.selector, "selector")).click({
          timeout: boundedTimeout(args.timeoutMs),
        });
        await saveState();
        return { url: current.url(), title: await current.title() };
      }
      if (name === "type") {
        await current
          .locator(requiredString(args.selector, "selector"))
          .fill(requiredString(args.text, "text").slice(0, 100_000), {
            timeout: boundedTimeout(args.timeoutMs),
          });
        await saveState();
        return { typed: true };
      }
      if (name === "select") {
        const selected = await current
          .locator(requiredString(args.selector, "selector"))
          .selectOption(requiredString(args.value, "value"));
        await saveState();
        return { selected };
      }
      if (name === "scroll") {
        const x = boundedNumber(args.x, 0, -100_000, 100_000);
        const y = boundedNumber(args.y, 600, -100_000, 100_000);
        await current.evaluate(({ x, y }) => window.scrollBy(x, y), { x, y });
        return { scrolled: true, x, y };
      }
      if (name === "wait") {
        if (typeof args.selector === "string") {
          await current.locator(args.selector).waitFor({ timeout: boundedTimeout(args.timeoutMs) });
        } else {
          await current.waitForTimeout(
            Math.min(boundedNumber(args.timeoutMs, 500, 1, 30_000), 30_000),
          );
        }
        return { waited: true };
      }
      if (name === "screenshot") {
        const bytes = await current.screenshot({
          type: "png",
          fullPage: args.fullPage === true,
        });
        const artifactPath = await writeBrowserArtifact(
          bindings,
          input.context,
          safeArtifactPath(
            typeof args.path === "string"
              ? args.path
              : `.flary/artifacts/browser/screenshot-${crypto.randomUUID()}.png`,
          ),
          bytesToBase64(bytes),
          "image/png",
        );
        return artifactPath
          ? { mediaType: "image/png", artifactPath, size: bytes.byteLength }
          : { mediaType: "image/png", base64: bytesToBase64(bytes) };
      }
      if (name === "download") {
        const downloadPromise = current.waitForEvent("download", {
          timeout: boundedTimeout(args.timeoutMs),
        });
        await current.locator(requiredString(args.selector, "selector")).click({
          timeout: boundedTimeout(args.timeoutMs),
        });
        const download = await downloadPromise;
        const failure = await download.failure();
        if (failure) throw new Error(`Browser download failed: ${failure}`);
        const bytes = await readDownload(await download.createReadStream());
        const path = safeArtifactPath(
          typeof args.path === "string"
            ? args.path
            : `downloads/${safeFilename(download.suggestedFilename())}`,
        );
        const artifactPath = await writeBrowserArtifact(
          bindings,
          input.context,
          path,
          bytesToBase64(bytes),
          "application/octet-stream",
        );
        if (!artifactPath) {
          throw new Error("Browser downloads need the generated durable workspace binding");
        }
        await download.delete().catch(() => undefined);
        return { artifactPath, size: bytes.byteLength };
      }
      if (name === "console")
        return { entries: consoleEntries.slice(-boundedLimit(args.limit, 100)) };
      if (name === "network")
        return { entries: networkEntries.slice(-boundedLimit(args.limit, 100)) };
      if (name === "evaluate") {
        const expression = requiredString(args.expression, "expression");
        if (expression.length > 16_384) throw new Error("Browser evaluation is too large");
        const evaluated = await current.evaluate(expression);
        await saveState();
        return { value: evaluated };
      }
      if (name === "status") {
        return {
          sessionId: browser?.sessionId(),
          url: current.url(),
          title: await current.title(),
          control: "agent",
        };
      }
      if (name === "close") {
        await saveState();
        await browser?.close();
        sql?.exec("DELETE FROM flary_browser_sessions WHERE profile_key = ?", profileKey);
        browser = undefined;
        context = undefined;
        page = undefined;
        return { closed: true };
      }
      throw new Error(`Browser tool '${name}' is not available`);
    },
  };
}

/** Deterministic tenant and thread scoped R2 key for encrypted browser state. */
export function browserStateObjectKey(input: {
  readonly organizationId: string;
  readonly appId: string;
  readonly threadId: string;
}): string {
  return [
    "tenants",
    encodeURIComponent(input.organizationId),
    "applications",
    encodeURIComponent(input.appId),
    "threads",
    encodeURIComponent(input.threadId),
    "browser",
    "state.enc",
  ].join("/");
}

function browserStateStore(
  bindings: Record<string, unknown>,
  runId: string | undefined,
):
  | {
      load(): Promise<Awaited<ReturnType<BrowserContext["storageState"]>> | undefined>;
      save(value: Awaited<ReturnType<BrowserContext["storageState"]>>): Promise<void>;
    }
  | undefined {
  if (!runId) return undefined;
  let ref: ReturnType<typeof parseThreadName>;
  try {
    ref = parseThreadName(runId);
  } catch {
    return undefined;
  }
  const bucket = bindings.FLARY_SESSION_ARCHIVE as BrowserStateBucket | undefined;
  const secret = bindings.FLARY_SESSION_ARCHIVE_KEY;
  if (!bucket || typeof secret !== "string" || secret.length < 32) return undefined;
  const key = browserStateObjectKey(ref);
  const aad = new TextEncoder().encode(key);
  return {
    async load() {
      const object = await bucket.get(key);
      if (!object) return undefined;
      const envelope = record(JSON.parse(new TextDecoder().decode(await object.arrayBuffer())));
      if (envelope.version !== 1) throw new Error("The browser state version is not supported");
      const clear = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64ToBytes(String(envelope.iv ?? "")) as unknown as BufferSource,
          additionalData: aad,
        },
        await browserStateKey(secret),
        base64ToBytes(String(envelope.ciphertext ?? "")) as unknown as BufferSource,
      );
      return JSON.parse(new TextDecoder().decode(clear));
    },
    async save(value) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          await browserStateKey(secret),
          new TextEncoder().encode(JSON.stringify(value)),
        ),
      );
      await bucket.put(
        key,
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            iv: bytesToBase64(iv),
            ciphertext: bytesToBase64(ciphertext),
          }),
        ),
        { httpMetadata: { contentType: "application/octet-stream" } },
      );
    },
  };
}

async function browserStateKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function base64ToBytes(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function writeBrowserArtifact<TBindings>(
  bindings: Record<string, unknown>,
  context: FlaryStepContext<TBindings>,
  path: string,
  content: string,
  mediaType: string,
): Promise<string | undefined> {
  const namespace = bindings.FLARY_WORKSPACE as
    Parameters<typeof createCloudflareWorkspaceConnection>[0] | undefined;
  const identity = context.identity;
  if (!namespace || !identity?.tenantId || !identity.projectId) return undefined;
  const workspaceId =
    typeof identity.workspaceId === "string" ? identity.workspaceId : context.runId;
  if (!workspaceId) return undefined;
  const ref = context.runId
    ? (() => {
        try {
          return parseThreadName(context.runId!);
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const workspace = await createCloudflareWorkspaceConnection(namespace, {
    organizationId: identity.tenantId,
    appId: identity.applicationId ?? ref?.appId ?? "flary",
    projectId: identity.projectId,
    workspaceId,
    branch: typeof identity.branch === "string" ? identity.branch : "main",
  });
  await workspace.call("write", {
    path,
    content,
    encoding: "base64",
    mediaType,
  });
  return path;
}

async function readDownload(stream: unknown): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const iterable = stream as AsyncIterable<Uint8Array | ArrayBuffer | string>;
  for await (const chunk of iterable) {
    const bytes =
      typeof chunk === "string"
        ? new TextEncoder().encode(chunk)
        : chunk instanceof Uint8Array
          ? chunk
          : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > 32 * 1024 * 1024) {
      throw new Error("Browser downloads are limited to 32 MiB");
    }
    chunks.push(bytes);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function safeArtifactPath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    !path ||
    path.length > 2_000 ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("The browser artifact path is unsafe");
  }
  return path;
}

function safeFilename(value: string): string {
  const name = value.replaceAll("\\", "/").split("/").at(-1) ?? "download.bin";
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  return safe && safe !== "." && safe !== ".." ? safe : "download.bin";
}

async function registerBrowserSession(
  bindings: Record<string, unknown>,
  runId: string | undefined,
  sessionId: string,
): Promise<void> {
  const target = browserControlTarget(bindings, runId);
  if (!target) return;
  await target.stub.fetch(
    new Request("https://flary.internal/browser", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "browser",
        tenantId: target.ref.organizationId,
        applicationId: target.ref.appId,
        action: "register",
        input: { sessionId },
      }),
    }),
  );
}

async function assertAgentBrowserControl(
  bindings: Record<string, unknown>,
  runId: string | undefined,
): Promise<void> {
  const target = browserControlTarget(bindings, runId);
  if (!target) return;
  const response = await target.stub.fetch(
    new Request("https://flary.internal/browser", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "browser",
        tenantId: target.ref.organizationId,
        applicationId: target.ref.appId,
        action: "status",
        input: {},
      }),
    }),
  );
  const value = record(await response.json().catch(() => ({})));
  if (record(value.browser).control === "human") {
    throw new Error("Browser actions are paused while a human controls the session");
  }
}

function browserControlTarget(
  bindings: Record<string, unknown>,
  runId: string | undefined,
):
  | {
      ref: ReturnType<typeof parseThreadName>;
      stub: { fetch(request: Request): Promise<Response> };
    }
  | undefined {
  if (!runId) return undefined;
  const namespace = bindings.FLARY_THREAD_CONTROL as
    | {
        idFromName(name: string): unknown;
        get(id: unknown): { fetch(request: Request): Promise<Response> };
      }
    | undefined;
  if (!namespace) return undefined;
  let ref: ReturnType<typeof parseThreadName>;
  try {
    ref = parseThreadName(runId);
  } catch {
    return undefined;
  }
  const name = `thread:${ref.organizationId}:${ref.appId}:${ref.threadId}`;
  return { ref, stub: namespace.get(namespace.idFromName(name)) };
}

function descriptor(
  name: string,
  description: string,
  write: boolean,
  required: string[] = [],
): FlaryToolConnection["descriptors"][number] {
  return {
    name,
    description,
    operation: write ? "write" : "read",
    requiresApproval: write,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(required.map((key) => [key, { type: "string" }])),
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: true,
    },
  };
}

function browserSql(value: unknown): BrowserSql | undefined {
  if (!value || typeof value !== "object") return undefined;
  const sql = "sql" in value ? (value as { sql?: unknown }).sql : value;
  return sql && typeof sql === "object" && "exec" in sql && typeof sql.exec === "function"
    ? (sql as BrowserSql)
    : undefined;
}

/** Apply the same fail-closed navigation policy to agent and human input. */
export function assertPublicBrowserUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Browser navigation only supports HTTP and HTTPS");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1" ||
    host === "metadata.google.internal" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "169.254.169.254" ||
    isPrivateIp(host) ||
    /^(?:\[)?(?:fc|fd|fe8|fe9|fea|feb)/i.test(host)
  ) {
    throw new Error("Browser navigation to private networks is blocked");
  }
  url.username = "";
  url.password = "";
  return url;
}

function isPrivateIp(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Browser ${name} is required`);
  return value;
}

function boundedKeepAlive(value: unknown): number {
  return boundedNumber(value, 600_000, 10_000, 600_000);
}

function boundedTimeout(value: unknown): number {
  return boundedNumber(value, 15_000, 1, 60_000);
}

function boundedLimit(value: unknown, fallback: number): number {
  return boundedNumber(value, fallback, 1, 500);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += String.fromCharCode(byte);
  return btoa(output);
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}
