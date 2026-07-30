import { Hono } from "hono";

type SiteBindings = {
  APP_ENV: string;
  ASSETS?: Fetcher;
  FLARY_RUNTIME?: Fetcher;
};

type SiteContext = {
  Bindings: SiteBindings;
};

const app = new Hono<SiteContext>();
const api = new Hono<SiteContext>();
const DOCS_HOSTNAME = "docs.flary.dev";

function resolveAssetRequest(request: Request): Request | Response {
  const url = new URL(request.url);

  if (url.hostname !== DOCS_HOSTNAME) {
    return request;
  }

  if (url.pathname === "/docs" || url.pathname.startsWith("/docs/")) {
    const target = new URL(url);
    target.pathname =
      url.pathname === "/docs" || url.pathname === "/docs/"
        ? "/"
        : url.pathname.slice("/docs".length);
    return Response.redirect(target, 308);
  }

  const lastSegment = url.pathname.split("/").at(-1) ?? "";
  const isStaticAsset =
    url.pathname.startsWith("/_astro/") ||
    url.pathname.startsWith("/fonts/") ||
    lastSegment.includes(".");

  if (isStaticAsset) {
    return request;
  }

  const target = new URL(url);
  target.pathname =
    url.pathname === "/" ? "/docs/" : `/docs${url.pathname}`;
  return new Request(target, request);
}

app.use("*", async (context, next) => {
  await next();
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Referrer-Policy", "strict-origin-when-cross-origin");
  context.header("X-Frame-Options", "DENY");
  context.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
});

app.get("/health", (context) =>
  context.json({
    ok: true,
    service: "flary-web",
    environment: context.env.APP_ENV,
  }),
);

api.get("/health", (context) =>
  context.json({
    ok: true,
    service: "flary-web",
    runtimeConnected: Boolean(context.env.FLARY_RUNTIME),
  }),
);

api.all("/runtime/*", async (context) => {
  if (!context.env.FLARY_RUNTIME) {
    return context.json(
      {
        error: {
          type: "runtime_unavailable",
          message: "The Flary runtime service binding is not configured.",
        },
      },
      503,
    );
  }

  const target = new URL(context.req.url);
  target.pathname =
    target.pathname.replace(/^\/api\/runtime/, "") || "/";

  return context.env.FLARY_RUNTIME.fetch(
    new Request(target, context.req.raw),
  );
});

api.notFound((context) =>
  context.json(
    {
      error: {
        type: "not_found",
        message: "API route not found.",
      },
    },
    404,
  ),
);

app.route("/api", api);

app.all("/api/*", (context) =>
  context.json(
    {
      error: {
        type: "not_found",
        message: "API route not found.",
      },
    },
    404,
  ),
);

app.get("/app/*", async (context) => {
  if (!context.env.ASSETS) {
    return context.json(
      {
        error: {
          type: "assets_unavailable",
          message: "The website asset binding is not available.",
        },
      },
      503,
    );
  }

  const target = new URL("/app/index.html", context.req.url);
  return context.env.ASSETS.fetch(new Request(target, context.req.raw));
});

app.all("*", async (context) => {
  if (context.env.ASSETS) {
    const assetRequest = resolveAssetRequest(context.req.raw);

    if (assetRequest instanceof Response) {
      return assetRequest;
    }

    return context.env.ASSETS.fetch(assetRequest);
  }
  return context.text("Not found", 404);
});

export default app;
