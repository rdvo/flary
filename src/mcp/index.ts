import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DurableObjectState, DurableObject, DurableObjectNamespace } from '@cloudflare/workers-types';
import { EdgeSSETransport } from './transports/edgeSSE.js';
import { WebSocketTransport } from './transports/webSockets.js';
import { Hono, Context } from 'hono';
import { z } from 'zod';

// Define the Env interface for type safety
export interface Env {
	MCP_OBJECT: DurableObjectNamespace;
}

// Simple config interface - no transport config needed
interface MCPConfig {
	name: string;
	version: string;
	description?: string;
	auth?: {
		type: 'bearer';
		token?: string;
		validate?: (token: string) => boolean | Promise<boolean>;
	};
}

export class MCP {
	#server: McpServer;
	#app: Hono;
	McpObject: any;
	#config: MCPConfig;

	constructor(config: MCPConfig) {
		this.#config = config;
		// Initialize the MCP server
		this.#server = new McpServer({
			name: config.name,
			version: config.version,
			description: config.description,
			capabilities: {
				prompts: {},
				tools: {},
				resources: {}
			}
		});

		// Initialize Hono app
		this.#app = new Hono();
		
		// Set up authentication middleware
		this.#app.use('*', async (c, next) => {
			if (this.#config.auth?.type === 'bearer') {
				// Get token from either the Authorization header or the key query parameter
				const authHeader = c.req.header('Authorization');
				const queryKey = c.req.query('key');
				let token: string | null = null;

				// Check Authorization header first
				if (authHeader && authHeader.startsWith('Bearer ')) {
					token = authHeader.split(' ')[1];
				}
				// Check query parameter if header is not present
				else if (queryKey) {
					token = queryKey;
				}
				
				// If no token found in either place, return unauthorized
				if (!token) {
					return new Response('Unauthorized - Bearer token required in header or key parameter', { status: 401 });
				}
				
				// If a validate function is provided, use it
				if (this.#config.auth.validate) {
					const isValid = await this.#config.auth.validate(token);
					if (!isValid) {
						return new Response('Unauthorized - Invalid token', { status: 401 });
					}
				}
				// If a specific token is provided, check against it
				else if (this.#config.auth.token && token !== this.#config.auth.token) {
					return new Response('Unauthorized - Invalid token', { status: 401 });
				}
			}
			return next();
		});
		
		// Set up a unified route handler for all MCP endpoints
		this.#app.all('/*', async (c: Context) => {
			const sessionId = c.req.query('sessionId');
			const object = c.env.MCP_OBJECT.get(
				sessionId ? c.env.MCP_OBJECT.idFromString(sessionId) : c.env.MCP_OBJECT.newUniqueId(),
			);
			return object.fetch(c.req.raw);
		});

		// Create the Durable Object class and attach it directly to this instance
		const serverFactory = () => this.#server;
		this.McpObject = class extends MCPDurableObject {
			constructor(state: DurableObjectState, env: Env) {
				super(state, env, serverFactory);
			}
		};
	}

	/**
	 * Add a tool to the MCP server with type inference from Zod schema
	 */
	tool<T extends z.ZodObject<any>>(
		name: string,
		schemaOrHandler: T | ((args: any) => any),
		handler?: (args: z.infer<T>) => any
	) {
		// If only two arguments are provided and the second is a function,
		// try to get schema from the function's schema property
		let schema: T;
		let finalHandler: (args: any) => any;

		if (typeof schemaOrHandler === 'function' && !handler) {
			const fn = schemaOrHandler as any;
			if (!fn.schema || typeof fn.schema !== 'object') {
				throw new Error(`Function ${name} must have a schema property when used directly`);
			}
			schema = fn.schema;
			finalHandler = fn;
		} else {
			schema = schemaOrHandler as T;
			finalHandler = handler!;
		}

		const wrappedHandler = async (args: any, extra: any) => {
			try {
				// Parse and validate the input with the schema
				const validatedArgs = schema.parse(args);
				const result = await finalHandler(validatedArgs);
				
				if (result && typeof result === 'object' && Array.isArray(result.content)) {
					return result;
				}
				
				return {
					content: [
						{
							type: 'text',
							text: String(result)
						}
					]
				};
			} catch (error) {
				console.error(`[MCP] Error in tool handler for ${name}:`, error);
				throw error;
			}
		};
		
		// Make sure schema is properly defined before passing it to the server
		if (!schema || typeof schema !== 'object') {
			console.error(`[MCP] Invalid schema for tool ${name}`);
			throw new Error(`Invalid schema for tool ${name}`);
		}
		
		// Pass the schema directly to the server - it knows how to handle Zod schemas
		console.log(`[MCP] Registering tool: ${name}`);
		// Use the schema's shape for the MCP server which expects ZodRawShape
		this.#server.tool(name, schema.shape as any, (args: any, extra: any) => wrappedHandler(args, extra));
		return this;
	}

	/**
	 * Add a resource to the MCP server
	 */
	resource(uri: string, handler: () => Promise<string | object>, options: {
		name?: string;
		description?: string;
		mimeType?: string;
	} = {}) {
		this.#server.resource(
			options.name || uri,
			uri,
			{
				description: options.description,
				mimeType: options.mimeType || 'text/plain'
			},
			async () => {
				const result = await handler();
				
				if (typeof result === 'string') {
					return {
						contents: [{
							uri,
							mimeType: options.mimeType || 'text/plain',
							text: result
						}]
					};
				} else {
					return {
						contents: [{
							uri,
							mimeType: options.mimeType || 'application/json',
							text: JSON.stringify(result)
						}]
					};
				}
			}
		);
		
		return this;
	}

	get fetch() {
		return this.#app.fetch;
	}
}

/**
 * Durable Object implementation for MCP with protocol auto-detection
 */
class MCPDurableObject {
	private sseTransport: EdgeSSETransport | null = null;
	private wsTransports: Map<string, WebSocketTransport> = new Map();
	private server: McpServer;
	private state: DurableObjectState;
	private env: Env;

	constructor(
		state: DurableObjectState,
		env: Env,
		serverFactory: () => McpServer,
	) {
		this.state = state;
		this.env = env;
		this.server = serverFactory();
	}

	private async setupSSETransport(url: URL): Promise<EdgeSSETransport> {
		console.log(`[MCP] Setting up SSE transport for URL: ${url.toString()}`);
		console.log(`[MCP] Current sseTransport:`, this.sseTransport ? 'exists' : 'null');
		
		if (!this.sseTransport) {
			// Preserve all query parameters by appending them to the messageUrl
			const messageUrl = new URL(`${url.origin}/message`);
			// Copy all URL parameters to the messageUrl
			url.searchParams.forEach((value, key) => {
				messageUrl.searchParams.set(key, value);
			});
			
			console.log(`[MCP] Creating new SSE transport with messageUrl: ${messageUrl.toString()}`);
			this.sseTransport = new EdgeSSETransport(messageUrl.toString(), this.state.id.toString());
			
			// Set up message forwarding to the server
			console.log(`[MCP] Setting up onmessage handler for SSE transport`);
			this.sseTransport.onmessage = async (message) => {
				console.log(`[MCP] Received message from client:`, message);
				try {
					// Connect to the server if not already connected
					if (!this.sseTransport?.onmessage) {
						await this.server.connect(this.sseTransport!);
					}
				} catch (error) {
					console.error(`[MCP] Error handling message:`, error);
					if (this.sseTransport?.onerror) {
						this.sseTransport.onerror(error as Error);
					}
					// Send error response if possible
					const rpcMessage = message as { id?: number | string };
					if (rpcMessage.id !== undefined) {
						await this.sseTransport?.send({
							jsonrpc: '2.0',
							id: rpcMessage.id,
							error: {
								code: -32000,
								message: String(error)
							}
						});
					}
				}
			};
			
			console.log(`[MCP] SSE transport created`);
		} else {
			console.log(`[MCP] Reusing existing SSE transport`);
			
			// Double-check that the onmessage handler is still set
			if (!this.sseTransport.onmessage) {
				console.log(`[MCP] Re-setting onmessage handler for existing SSE transport`);
				this.sseTransport.onmessage = async (message) => {
					console.log(`[MCP] Received message from client:`, message);
					try {
						// Connect to the server if not already connected
						if (!this.sseTransport?.onmessage) {
							await this.server.connect(this.sseTransport!);
						}
					} catch (error) {
						console.error(`[MCP] Error handling message:`, error);
						if (this.sseTransport?.onerror) {
							this.sseTransport.onerror(error as Error);
						}
						// Send error response if possible
						const rpcMessage = message as { id?: number | string };
						if (rpcMessage.id !== undefined) {
							await this.sseTransport?.send({
								jsonrpc: '2.0',
								id: rpcMessage.id,
								error: {
									code: -32000,
									message: String(error)
								}
							});
						}
					}
				};
			}
		}
		
		// Connect to the server immediately
		try {
			await this.server.connect(this.sseTransport);
		} catch (error) {
			console.error(`[MCP] Error connecting to server:`, error);
			throw error;
		}
		
		return this.sseTransport;
	}

	private async setupWSTransport(url: URL, connectionId: string): Promise<WebSocketTransport> {
		// Create a new WS transport for each connection
		const messageUrl = new URL(`${url.origin}/message`);
		// Copy all URL parameters to the messageUrl
		url.searchParams.forEach((value, key) => {
			messageUrl.searchParams.set(key, value);
		});
		
		const transport = new WebSocketTransport(messageUrl.toString(), connectionId);
		this.wsTransports.set(connectionId, transport);
		return transport;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname;
		
		// Create a simple object from headers using a safer approach
		const headerObj: Record<string, string> = {};
		request.headers.forEach((value, key) => {
			headerObj[key] = value;
		});
		
		console.log(`[MCP] Request: ${request.method} ${pathname}`, {
			headers: headerObj,
			url: url.toString(),
			sessionId: this.state.id.toString()
		});
		
		try {
			// For backward compatibility, handle the specific /sse and /ws endpoints
			const isSpecificSseEndpoint = pathname.endsWith('/sse');
			const isSpecificWsEndpoint = pathname.endsWith('/ws');
			
			// Auto-detect protocol based on headers
			const upgradeHeader = request.headers.get('Upgrade');
			const isWebSocketRequest = upgradeHeader && upgradeHeader.toLowerCase() === 'websocket';
			const acceptHeader = request.headers.get('Accept');
			const isSSERequest = acceptHeader && acceptHeader.includes('text/event-stream');
			
			console.log(`[MCP] Protocol detection:`, {
				isSpecificSseEndpoint,
				isSpecificWsEndpoint,
				isWebSocketRequest,
				isSSERequest,
				acceptHeader,
				upgradeHeader
			});
			
			// Handle WebSocket connections (either through /ws or protocol detection)
			if (isWebSocketRequest && (isSpecificWsEndpoint || pathname === '/')) {
				console.log(`[MCP] Setting up WebSocket transport`);
				// Generate a unique connection ID for this WebSocket
				const connectionId = this.state.id.toString() + '-' + Date.now().toString();
				const wsTransport = await this.setupWSTransport(url, connectionId);
				try {
					console.log(`[MCP] Connecting WebSocket transport to server`);
					await this.server.connect(wsTransport);
					console.log(`[MCP] WebSocket transport connected successfully`);
				} catch (err) {
					const error = err as Error;
					console.error(`[MCP] Error connecting WebSocket transport:`, error);
					return new Response(`WebSocket connection error: ${error.message}`, { 
						status: 500,
						headers: { 'Content-Type': 'text/plain' }
					});
				}
				return wsTransport.handleUpgrade(request);
			}
			
			// Handle SSE connections (either through /sse or protocol detection)
			// If no specific protocol is requested via headers but it's a GET to root,
			// default to SSE for backward compatibility
			if (request.method === 'GET' && (
				isSpecificSseEndpoint || 
				isSSERequest || 
				(pathname === '/' && !isWebSocketRequest)
			)) {
				console.log(`[MCP] Setting up SSE transport for GET request`);
				
				// Extract sessionId from query params or generate a new one
				const urlSessionId = url.searchParams.get('sessionId');
				const sessionId = urlSessionId || this.state.id.toString();
				
				// If client didn't provide a sessionId, we should redirect them to a URL with the sessionId
				if (!urlSessionId) {
					console.log(`[MCP] No sessionId provided, redirecting to URL with sessionId: ${sessionId}`);
					const redirectUrl = new URL(url.toString());
					redirectUrl.searchParams.set('sessionId', sessionId);
					
					return new Response(null, {
						status: 307, // Temporary redirect
						headers: {
							'Location': redirectUrl.toString(),
							'Content-Type': 'text/plain',
							'Cache-Control': 'no-cache, no-store, must-revalidate'
						}
					});
				}
				
				const sseTransport = await this.setupSSETransport(url);
				console.log(`[MCP] Connecting SSE transport to server`);
				try {
					await this.server.connect(sseTransport);
					console.log(`[MCP] SSE transport connected successfully`);
				} catch (err) {
					const error = err as Error;
					console.error(`[MCP] Error connecting SSE transport:`, error);
					return new Response(`SSE connection error: ${error.message}`, { 
						status: 500,
						headers: { 'Content-Type': 'text/plain' }
					});
				}
				console.log(`[MCP] Returning SSE response`);
				return sseTransport.sseResponse;
			}
			
			// Handle message posting for SSE
			if (request.method === 'POST' && (pathname.endsWith('/message') || pathname === '/')) {
				console.log(`[MCP] Handling POST message`);
				// If no SSE transport exists yet, create one
				const sseTransport = await this.setupSSETransport(url);
				console.log(`[MCP] Connecting SSE transport for POST`);
				try {
					await this.server.connect(sseTransport);
					console.log(`[MCP] SSE transport connected successfully for POST`);
				} catch (err) {
					const error = err as Error;
					console.error(`[MCP] Error connecting SSE transport for POST:`, error);
					return new Response(`SSE connection error: ${error.message}`, { 
						status: 500,
						headers: { 'Content-Type': 'text/plain' }
					});
				}
				console.log(`[MCP] Handling POST message with transport`);
				return sseTransport.handlePostMessage(request);
			}
			
			// Return information about the server for the root path with specific JSON request
			// This is only reached if the client explicitly requests JSON
			if (request.method === 'GET' && pathname === '/' && 
				request.headers.get('Accept')?.includes('application/json')) {
				console.log(`[MCP] Returning JSON info response`);
				const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
				
				// Create base URLs and preserve all existing query parameters
				const wsBaseUrl = new URL(`${wsProtocol}//${url.host}/`);
				const sseBaseUrl = new URL(`${url.origin}/`);
				
				// Add sessionId parameter
				wsBaseUrl.searchParams.set('sessionId', this.state.id.toString());
				sseBaseUrl.searchParams.set('sessionId', this.state.id.toString());
				
				// Copy all URL parameters from the original request except sessionId
				// which we've already set
				url.searchParams.forEach((value, key) => {
					if (key !== 'sessionId') {
						wsBaseUrl.searchParams.set(key, value);
						sseBaseUrl.searchParams.set(key, value);
					}
				});
				
				const wsUrl = wsBaseUrl.toString();
				const sseUrl = sseBaseUrl.toString();
				
				return new Response(JSON.stringify({
					status: 'ready',
					message: 'MCP server is running',
					sessionId: this.state.id.toString(),
					transport_options: {
						sse: {
							info: "SSE transport with separate POST for messages",
							connect: `GET ${sseUrl} with Accept: text/event-stream header`,
							send_messages: `POST to ${sseUrl} with Content-Type: application/json`
						},
						websocket: {
							info: "WebSocket transport with bidirectional messaging",
							connect: `Connect to ${wsUrl} as WebSocket`,
							send_messages: "Send directly through the WebSocket connection"
						}
					},
					backward_compatibility: {
						sse: this.createCompatibilityUrl(url, '/sse', this.state.id.toString()),
						websocket: this.createCompatibilityUrl(url, '/ws', this.state.id.toString()),
						message: this.createCompatibilityUrl(url, '/message', this.state.id.toString())
					}
				}), {
					headers: {
						'Content-Type': 'application/json'
					}
				});
			}
			
			console.log(`[MCP] No matching handler found, returning 404`);
			return new Response('Not found', { status: 404 });
		} catch (error) {
			console.error(`[MCP] Error handling request:`, error);
			return new Response(String(error), {
				status: 500,
				headers: {
					'Content-Type': 'text/plain'
				}
			});
		}
	}

	private createCompatibilityUrl(url: URL, endpoint: string, sessionId: string): string {
		const baseUrl = new URL(url.origin);
		baseUrl.pathname = endpoint;
		
		// Copy all existing URL parameters
		url.searchParams.forEach((value, key) => {
			baseUrl.searchParams.set(key, value);
		});
		
		// Ensure sessionId is included (overriding any existing one)
		baseUrl.searchParams.set('sessionId', sessionId);
		
		return baseUrl.toString();
	}
}

// Export the MCP class as the default export
export { MCP as default };