import { Hono } from "hono";
import { cors } from "hono/cors";
import { app } from "./flary";
import { assistant } from "./assistant";
import { assistantConfig } from "./assistant.generated";
import { coder, reviewer } from "./coder";
import { generated } from "./flary.generated";
import { support } from "./support";
import { widgetDemo, widgetScript } from "./widget";

export const functions = { support, assistant, coder, reviewer };
const runtime = app.serve(functions);
const worker = new Hono();

worker.use(
  "/apps/assistant/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["content-type", "x-flary-widget-session"],
  }),
);
worker.get("/widget.js", (context) =>
  generated.widget
    ? context.text(widgetScript(), 200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      })
    : context.notFound(),
);
worker.get("/widget", (context) =>
  generated.widget ? context.html(widgetDemo(assistantConfig.name)) : context.notFound(),
);
worker.route("/", runtime as never);

export default worker;
