import { Hono } from "hono";
import { partyserverMiddleware } from "hono-party";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

// Define environment bindings
interface Bindings {
  canvas: DurableObjectNamespace;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

// Canvas party server for multiplayer functionality
export class Canvas extends YServer {
  static options = {
    hibernate: true,
  };

  state: DurableObjectState;
  awareness: Awareness;

  constructor(state: DurableObjectState, env: Bindings) {
    super(state, env);
    this.state = state;

    // The document already has awareness set up in WSSharedDoc
    this.awareness = this.document.awareness;

    // Handle awareness updates (user connections/disconnections)
    this.awareness.on("change", this.handleAwarenessUpdate.bind(this));
  }

  // Handle awareness updates and broadcast user count
  handleAwarenessUpdate() {
    try {
      // Count connected users (only count client states)
      const states = this.awareness.getStates();
      const clientStates = Array.from(states.values()).filter(
        (state) => state.type === "client"
      );
      const connectedUsers = clientStates.length;

      // Log for debugging
      console.log(
        `[Canvas] User presence update: ${connectedUsers} users online`
      );
      console.log("[Canvas] Current states:", Array.from(states.entries()));

      // Don't update the state if it's already correct to prevent recursion
      const currentState = this.awareness.getLocalState();
      if (currentState?.userCount === connectedUsers) {
        return;
      }

      // Update all connected clients with user count
      this.awareness.setLocalState({
        ...(currentState || {}),
        userCount: connectedUsers,
        type: "server", // Mark this as a server state update
        timestamp: Date.now(), // Add timestamp to force state update
      });
    } catch (error) {
      console.error("[Canvas] Error in handleAwarenessUpdate:", error);
    }
  }

  // Load persisted state
  async onLoad() {
    try {
      const storedState = await this.state.storage.get<Uint8Array>(
        "canvasState"
      );
      if (storedState) {
        Y.applyUpdate(this.document, storedState);
        console.log("[Canvas] Loaded stored state successfully");

        // Initialize maps if they don't exist
        this.document.getMap("nodes");
        this.document.getMap("edges");
      } else {
        console.log("[Canvas] No stored state found, using empty document");
        // Initialize with empty maps
        this.document.getMap("nodes");
        this.document.getMap("edges");
      }
    } catch (error) {
      console.error("[Canvas] Error loading state:", error);
      // Create empty maps in case of error
      this.document.getMap("nodes");
      this.document.getMap("edges");
    }
  }

  // Save state periodically
  async onSave() {
    try {
      const update = Y.encodeStateAsUpdate(this.document);
      await this.state.storage.put("canvasState", update);
      console.log("[Canvas] State saved successfully");
    } catch (error) {
      console.error("[Canvas] Error saving state:", error);
    }
  }
}

const app = new Hono<{ Bindings: Bindings }>();

// Debug middleware to log requests
app.use("*", async (c, next) => {
  console.log("[Debug] Request URL:", c.req.url);
  console.log("[Debug] Request path:", new URL(c.req.url).pathname);
  console.log("[Debug] Available env bindings:", Object.keys(c.env));
  if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
    console.log("[Debug] WebSocket upgrade request");
  }
  return next();
});

// Use party middleware with basic config
app.use("*", partyserverMiddleware());

// Health check route
app.get("/health", (c) =>
  c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  })
);

// Regular API routes
app.get("/api/health", (c) =>
  c.json({
    name: "canvas app",
    version: "1.0.0",
    status: "online",
    timestamp: new Date().toISOString(),
  })
);

// Handle WebSocket connections for Parties
app.get("/parties/*", async (c) => {
  console.log("[Manual Handler] Processing /parties/* request");
  const url = new URL(c.req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);

  console.log("[Manual Handler] Path parts:", pathParts);

  if (
    pathParts[0] === "parties" &&
    pathParts[1] === "canvas" &&
    pathParts.length >= 3
  ) {
    console.log(
      "[Manual Handler] Found canvas request for room:",
      pathParts[2]
    );

    // Check if we have the canvas binding
    if (!c.env.canvas || typeof c.env.canvas.idFromName !== "function") {
      console.error("[Manual Handler] canvas binding not found or invalid");
      return new Response("Canvas binding not found", { status: 500 });
    }

    // Get the DO stub
    try {
      const id = c.env.canvas.idFromName(pathParts[2]);
      const stub = c.env.canvas.get(id);

      console.log("[Manual Handler] Successfully created DO stub");

      // Forward the request to the DO
      return stub.fetch(c.req.raw);
    } catch (error) {
      console.error("[Manual Handler] Error creating DO stub:", error);
      return new Response("Error creating Durable Object", { status: 500 });
    }
  }

  // If no matches, return a 404
  return new Response("Not found", { status: 404 });
});

// Handle all other routes for static assets and SPA
app.all("*", async (c) => {
  return await c.env.ASSETS.fetch(c.req.raw);
});

export default app;
