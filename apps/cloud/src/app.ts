import { Hono } from "hono";
import cloudApp from "../worker/index";
import { flueApp } from "./flue-app";

const app = new Hono();

// Flue owns canonical agent streams and durable admission. The control plane
// remains responsible for auth, application APIs, and static assets.
// Flue and the control-plane app can resolve compatible Hono versions from
// separate package trees. Both expose the same runtime route contract.
app.route("/api/flue", flueApp as never);
app.all("*", (context) =>
  cloudApp.fetch(context.req.raw, context.env as never, context.executionCtx),
);

export default app;
