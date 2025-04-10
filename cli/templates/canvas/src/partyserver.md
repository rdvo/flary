Why Use PartyServer?
PartyServer enhances Durable Objects with the following features:

Simple "room"-based routing
Lifecycle hooks for connections and requests
A unified API for managing hibernated and non-hibernated Durable Objects
Easy broadcasting to all or selected connections in a server
How is it different from PartyKit?
Decouples the idea of a URL from the server name. This is useful when you want to associate a server with some other identifier like a session ID, etc. You can still use routePartykitRequest() to get PartyKit-style route matching.
Doesn't include bindings for other services like AI, static assets, etc. Instead, use wrangler's built-in support for those services.
Doesn't have PartyKit's auto-inferred declaration for Durable Object bindings and migrations, so you have to manually specify these in wrangler.toml. We may add this in the future.
Usage
Here's an example of how to use PartyServer:

Write your code:

// index.ts

import { routePartykitRequest, Server } from "partyserver";

// Define your Server
export class MyServer extends Server {
onConnect(connection) {
console.log("Connected", connection.id, "to server", this.name);
}

onMessage(connection, message) {
console.log("Message from", connection.id, ":", message);
// Send the message to every other connection
this.broadcast(message, [connection.id]);
}
}

export default {
// Set up your fetch handler to use configured Servers
fetch(request, env) {
return (
routePartykitRequest(request, env) ||
new Response("Not Found", { status: 404 })
);
}
};
And configure your wrangler.toml:

name = "my-partyserver-app"
main = "index.ts"

[[durable_objects.bindings]]
name = "MyServer"
class_name = "MyServer"

[[migrations]]
tag = "v1" # Should be unique for each entry
new_classes = ["MyServer"]
You can connect to the server from a client (like a browser or a mobile app) using partysocket or any other WebSocket client.

import { PartySocket } from "partysocket";

const socket = new PartySocket({
host: "https://my-partyserver-app.threepointone.workers.dev", // optional, defaults to window.location.host,
party: "my-server", // the server name. if you use routePartykitRequest, it automatically uses the kebab-cased version of the binding name (MyServer -> my-server)
room: "my-room"
});
See the /fixtures folder for more specific examples.

Customizing Server
Server is a class that extends DurableObject. You can override the following methods on Server to add custom behavior:

Lifecycle Hooks
These methods can be optionally async:

onStart(): Called when the server starts for the first time or after waking up from hibernation. You can use this to load data from storage and perform other initialization, such as retrieving data or configuration from other services or databases.

onConnect(connection, context) - Called when a new websocket connection is established. You can use this to set up any connection-specific state or perform other initialization. Receives a reference to the connecting Connection, and a ConnectionContext that provides information about the initial connection request.

onMessage(connection, message) - Called when a message is received on a connection.

onClose(connection, code, reason, wasClean) - Called when a connection is closed by a client. By the time onClose is called, the connection is already closed and can no longer receive messages.

onError(connection, error) - Called when an error occurs on a connection.

onRequest(request): Response - Called when a request is made to the server. This is useful for handling HTTP requests in addition to WebSocket connections.

onAlarm() - Called when an alarm is triggered. You can set an alarm by calling this.ctx.storage.setAlarm(Date). Read more about Durable Objects alarms here.

getConnectionTags(connection, context): string[] - You can set additional metadata on connections by returning them from getConnectionTags(), and then filter connections based on the tag with this.getConnections.

Additional Methods
broadcast(message, exclude = []) - Send a message to all connections, optionally excluding connection ids listed in the second array parameter.

getConnections(tags = []) - Get all currently connected WebSocket connections, optionally filtered by tags set by getConnectionTags(). Returns an iterable list of Connection.

getConnection(id) - Get a connection by its ID.

Properties
.name - (readonly) this is automatically set to the server's "name", determined by getServerByName() or routePartykitRequest().

.ctx - the context object for the Durable Object, containing references to storage

.env - the environment object for the Durable Object, defined by bindings and other configuration in your wrangler.toml configuration file.

Durable Object methods
fetch(request) - PartyServer overrides the fetch method to add the lifecycle methods to the server instance. In most cases you don't have to implement this mehod yourself. If you do (for example, to add request handling before any lifecycle methods are called), make sure to call super.fetch(request) as appropriate to ensure the lifecycle methods are called.

alarm() - You should not implement/override this yourself, use onAlarm() instead. This method is called whenever an alarm is triggered. This is the only way to run code after the server has been evicted. Read more about alarms here.

Do not implement any of these methods on your server class: webSocketMessage /webSocketClose / webSocketError / alarm. We override them to call the lifecycle methods in hibernation mode.

Connection Properties
A connection is a standard WebSocket with the following additional properties:

id - A unique ID for the connection
tags - An array of tags assigned to the connection (TODO)
server - The server name the connection is in
state - Arbitrary state data (up to 2KB) that can be set on the connection using connection.setState()
Hibernation
You can enable hibernation by setting a static options property on your Server class. This allows the server to hibernate when not in use and wake up when a new connection is established. All lifecycle hooks will be called as expected when the server wakes up.

export class MyServer extends Server {
static options = {
hibernate: true
};
// ...
}
Utility Methods
getServerByName(namespace, name, {locationHint, jurisdiction}): Promise<DurableObjectStub> - Create a new Server with a specific name. Optionally pass a locationHint to specify the location or jurisdiction to specify the jurisdiction of the server.

routePartykitRequest(request, env, {locationHint, jurisdiction, prefix = 'parties', onBeforeConnect, onBeforeRequest}): Promise<Response | null> - Match a request to a server. Takes a URL of the form /${prefix}/:server/:name and matches it with any namespace named :server (case insensitive) and a server named :name. Optionally pass a locationHint to specify the location or jurisdiction to specify the jurisdiction of the server.

onBeforeConnect(request, {party: string, name: string}): Request | Response | void - A function that can modify the request for a websocket connection before it's passed to the server.
If it returns a Request, it will be used instead of the original request. Use this to modify headers or other request properties before passing it to the partyserver instance / durable object.
If it returns a Response, it will be returned instead of the original request. Use this to return a custom response, such as a 404 or 403.
If it returns undefined or null, the request will be passed to the server as normal.
onBeforeRequest - A function that can modify the request before it's passed to the server. This is exactly the same as onBeforeConnect, but for HTTP requests.

//// ## HONO IMPELMENTATION ///

import { Hono } from "hono";
import { partyserverMiddleware } from "hono-party";
import { Server } from "partyserver";

import type { Connection, WSMessage } from "partyserver";

// Multiple party servers
export class Chat extends Server {
onMessage(connection: Connection, message: WSMessage): void | Promise<void> {
console.log("onMessage", message);
this.broadcast(message, [connection.id]);
}
}

const app = new Hono();
app.use("\*", partyserverMiddleware());

app.get("/", (c) => c.text("Hello from Hono!"));

export default app;
