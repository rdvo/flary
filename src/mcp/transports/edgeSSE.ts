import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessage, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

const MAXIMUM_MESSAGE_SIZE = 4 * 1024 * 1024; // 4MB
const KEEP_ALIVE_INTERVAL = 15000; // Send ping every 15 seconds

/**
 * This transport is compatible with Cloudflare Workers and other edge environments
 */
export class EdgeSSETransport implements Transport {
	private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	readonly stream: ReadableStream<Uint8Array>;
	private closed = false;
	private keepAliveInterval: any = null;
	private lastPingTime: number = Date.now();

	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;

	/**
	 * Creates a new EdgeSSETransport, which will direct the MPC client to POST messages to messageUrl
	 */
	constructor(
		private messageUrl: string,
		readonly sessionId: string,
	) {
		console.log(`[EdgeSSE] Creating transport with messageUrl: ${messageUrl}, sessionId: ${sessionId}`);
		// Create a readable stream for SSE with automatic keep-alive
		this.stream = new ReadableStream({
			start: (controller) => {
				console.log(`[EdgeSSE] Stream started, initializing controller`);
				this.controller = controller;
				
				// Send initial retry directive to client
				const retryMessage = `retry: 1000\n\n`;
				console.log(`[EdgeSSE] Sending initial retry directive: ${retryMessage.trim()}`);
				controller.enqueue(new TextEncoder().encode(retryMessage));
				
				// Send the session ID to the client immediately
				const sessionMessage = `event: session\ndata: ${this.sessionId}\n\n`;
				console.log(`[EdgeSSE] Sending session ID: ${sessionMessage.trim()}`);
				controller.enqueue(new TextEncoder().encode(sessionMessage));
				
				// Start keep-alive after a short delay to ensure initial messages are sent
				setTimeout(() => this.startKeepAlive(), 100);
			},
			cancel: () => {
				console.log(`[EdgeSSE] Stream cancelled, cleaning up`);
				this.cleanup();
			},
		});
	}

	private startKeepAlive() {
		// Clear any existing interval
		if (this.keepAliveInterval) {
			console.log(`[EdgeSSE] Clearing existing keep-alive interval`);
			clearInterval(this.keepAliveInterval);
		}

		// Start aggressive keep-alive pings
		console.log(`[EdgeSSE] Starting keep-alive pings every ${KEEP_ALIVE_INTERVAL}ms`);
		this.keepAliveInterval = setInterval(() => {
			if (!this.closed && this.controller) {
				this.lastPingTime = Date.now();
				const pingMessage = `event: ping\ndata: ${this.lastPingTime}\n\n`;
				console.log(`[EdgeSSE] Sending ping: ${this.lastPingTime}`);
				this.controller.enqueue(new TextEncoder().encode(pingMessage));
			}
		}, KEEP_ALIVE_INTERVAL);
	}

	private cleanup() {
		console.log(`[EdgeSSE] Cleaning up transport`);
		if (this.keepAliveInterval) {
			clearInterval(this.keepAliveInterval);
			this.keepAliveInterval = null;
		}
		this.closed = true;
		if (this.onclose) {
			console.log(`[EdgeSSE] Calling onclose handler`);
			this.onclose();
		}
	}

	async start(): Promise<void> {
		console.log(`[EdgeSSE] Starting transport`);
		if (this.closed) {
			const error = 'SSE transport already closed! If using Server class, note that connect() calls start() automatically.';
			console.error(`[EdgeSSE] Error starting transport: ${error}`);
			throw new Error(error);
		}

		// Make sure the controller exists
		if (!this.controller) {
			const error = 'Stream controller not initialized';
			console.error(`[EdgeSSE] Error starting transport: ${error}`);
			throw new Error(error);
		}

		// Send the endpoint event with the full URL including sessionId
		const fullMessageUrl = `${this.messageUrl}?sessionId=${this.sessionId}`;
		const endpointMessage = `event: endpoint\ndata: ${encodeURI(fullMessageUrl)}\n\n`;
		console.log(`[EdgeSSE] Sending endpoint message: ${endpointMessage.trim()}`);
		this.controller.enqueue(new TextEncoder().encode(endpointMessage));
		
		// Also send a ready event to indicate the transport is fully initialized
		const readyMessage = `event: ready\ndata: true\n\n`;
		console.log(`[EdgeSSE] Sending ready message: ${readyMessage.trim()}`);
		this.controller.enqueue(new TextEncoder().encode(readyMessage));
	}

	get sseResponse(): Response {
		console.log(`[EdgeSSE] Getting SSE response`);
		// Ensure the stream is properly initialized
		if (!this.stream) {
			const error = 'Stream not initialized';
			console.error(`[EdgeSSE] Error getting SSE response: ${error}`);
			throw new Error(error);
		}

		// Reset the keep-alive timer
		console.log(`[EdgeSSE] Resetting keep-alive timer`);
		this.lastPingTime = Date.now();
		this.startKeepAlive();

		// Return a streaming response with appropriate headers
		console.log(`[EdgeSSE] Returning SSE response with headers`);
		return new Response(this.stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache, no-transform',
				'Connection': 'keep-alive',
				'Keep-Alive': 'timeout=120',
				'X-Accel-Buffering': 'no',
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type',
				'Access-Control-Expose-Headers': '*',
			},
		});
	}

	/**
	 * Handles incoming Requests
	 */
	async handlePostMessage(req: Request): Promise<Response> {
		console.log(`[EdgeSSE] Handling POST message`);
		if (this.closed || !this.controller) {
			const message = 'SSE connection not established';
			console.error(`[EdgeSSE] Error handling POST: ${message}`);
			return new Response(message, { status: 500 });
		}

		try {
			const contentType = req.headers.get('content-type') || '';
			console.log(`[EdgeSSE] POST content-type: ${contentType}`);
			if (!contentType.includes('application/json')) {
				const error = `Unsupported content-type: ${contentType}`;
				console.error(`[EdgeSSE] Error handling POST: ${error}`);
				throw new Error(error);
			}

			// Check if the request body is too large
			const contentLength = parseInt(req.headers.get('content-length') || '0', 10);
			console.log(`[EdgeSSE] POST content-length: ${contentLength}`);
			if (contentLength > MAXIMUM_MESSAGE_SIZE) {
				const error = `Request body too large: ${contentLength} bytes`;
				console.error(`[EdgeSSE] Error handling POST: ${error}`);
				throw new Error(error);
			}

			const body = await req.json();
			console.log(`[EdgeSSE] Received message:`, body);
			await this.handleMessage(body);

			console.log(`[EdgeSSE] Message handled successfully`);
			return new Response('Accepted', { status: 202 });
		} catch (error) {
			console.error(`[EdgeSSE] Error handling POST:`, error);
			if (this.onerror) {
				this.onerror(error as Error);
			}
			return new Response(String(error), { status: 400 });
		}
	}

	/**
	 * Handle a client message, regardless of how it arrived
	 */
	async handleMessage(message: unknown): Promise<void> {
		console.log(`[EdgeSSE] Handling message:`, message);
		let parsedMessage: JSONRPCMessage;
		try {
			parsedMessage = JSONRPCMessageSchema.parse(message);
			console.log(`[EdgeSSE] Message parsed successfully:`, parsedMessage);
		} catch (error) {
			console.error(`[EdgeSSE] Error parsing message:`, error);
			if (this.onerror) {
				this.onerror(error as Error);
			}
			throw error;
		}

		console.log(`[EdgeSSE] Calling onmessage handler with:`, parsedMessage);
		if (this.onmessage) {
			this.onmessage(parsedMessage);
		} else {
			console.warn(`[EdgeSSE] No onmessage handler registered`);
		}
	}

	async close(): Promise<void> {
		console.log(`[EdgeSSE] Closing transport`);
		if (!this.closed) {
			this.cleanup();
			if (this.controller) {
				try {
					console.log(`[EdgeSSE] Sending close message`);
					await this.send({ jsonrpc: '2.0', method: 'close', params: {} });
				} catch (error) {
					console.warn(`[EdgeSSE] Error sending close message:`, error);
					// Ignore errors during close
				}
				console.log(`[EdgeSSE] Closing controller and cancelling stream`);
				this.controller.close();
				this.stream.cancel();
			}
		} else {
			console.log(`[EdgeSSE] Transport already closed`);
		}
	}

	async send(message: JSONRPCMessage): Promise<void> {
		console.log(`[EdgeSSE] Sending message:`, message);
		if (this.closed || !this.controller) {
			const error = 'Not connected';
			console.error(`[EdgeSSE] Error sending message: ${error}`);
			throw new Error(error);
		}

		try {
			const messageText = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
			console.log(`[EdgeSSE] Enqueueing message: ${messageText.trim()}`);
			this.controller.enqueue(new TextEncoder().encode(messageText));
		} catch (error) {
			console.error(`[EdgeSSE] Error sending message:`, error);
			if (this.onerror) {
				this.onerror(error as Error);
			}
			throw error;
		}
	}
}