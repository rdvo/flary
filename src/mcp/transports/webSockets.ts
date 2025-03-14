import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessage, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { DurableObjectState, WebSocket } from '@cloudflare/workers-types';

const MAXIMUM_MESSAGE_SIZE = 4 * 1024 * 1024; // 4MB
const KEEP_ALIVE_INTERVAL = 15000; // Send ping every 15 seconds to match EdgeSSE
const MAX_RETRIES = 3;

// Cloudflare-specific types
interface CloudflareWebSocket extends WebSocket {
	accept(): void;
}

interface CloudflareWebSocketPair {
	0: WebSocket;
	1: WebSocket;
}

/**
 * WebSocket transport for Durable Objects
 */
export class WebSocketTransport implements Transport {
	private webSocket: CloudflareWebSocket | null = null;
	private closed = false;
	private keepAliveInterval: any = null;
	private lastPingTime: number = Date.now();
	private retryCount = 0;

	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;

	constructor(
		private messageUrl: string,
		readonly sessionId: string,
	) {}

	private startKeepAlive() {
		if (this.keepAliveInterval) {
			clearInterval(this.keepAliveInterval);
		}

		this.keepAliveInterval = setInterval(() => {
			if (!this.closed && this.webSocket?.readyState === 1) { // WebSocket.OPEN = 1
				this.lastPingTime = Date.now();
				this.webSocket.send(JSON.stringify({ type: 'ping', timestamp: this.lastPingTime }));
			}
		}, KEEP_ALIVE_INTERVAL);
	}

	private cleanup() {
		if (this.keepAliveInterval) {
			clearInterval(this.keepAliveInterval);
			this.keepAliveInterval = null;
		}
		this.closed = true;
		this.onclose?.();
	}

	async start(): Promise<void> {
		if (this.closed) {
			throw new Error('WebSocket transport already closed!');
		}

		// For Durable Objects, the connection happens in handleUpgrade
		// This method is mostly for API compatibility with other Transport implementations
		// Client-side initialization happens via handleUpgrade
	}

	private async handleReconnect() {
		if (this.retryCount < MAX_RETRIES && !this.closed) {
			this.retryCount++;
			await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, this.retryCount)));
			await this.start();
		}
	}

	async handleMessage(message: unknown): Promise<void> {
		// Reset retry count on successful message
		this.retryCount = 0;

		// Handle ping responses
		if (typeof message === 'object' && message !== null && 'type' in message) {
			if (message.type === 'ping') {
				return;
			}
		}

		let parsedMessage: JSONRPCMessage;
		try {
			parsedMessage = JSONRPCMessageSchema.parse(message);
		} catch (error) {
			this.onerror?.(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}

		this.onmessage?.(parsedMessage);
	}

	async close(): Promise<void> {
		if (!this.closed && this.webSocket) {
			try {
				await this.send({ jsonrpc: '2.0', method: 'close', params: {} });
				this.webSocket.close();
			} catch (error) {
				// Ignore errors during close
			}
			this.cleanup();
		}
	}

	async send(message: JSONRPCMessage): Promise<void> {
		if (this.closed || !this.webSocket || this.webSocket.readyState !== 1) { // WebSocket.OPEN = 1
			throw new Error('Not connected');
		}

		try {
			this.webSocket.send(JSON.stringify(message));
			this.lastPingTime = Date.now(); // Update last activity time
		} catch (error) {
			this.onerror?.(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	/**
	 * Handle WebSocket upgrade request in Durable Object
	 */
	async handleUpgrade(request: Request): Promise<Response> {
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
			return new Response('Expected Upgrade: websocket', { status: 426 });
		}

		// @ts-ignore - Cloudflare-specific WebSocketPair
		const pair = new WebSocketPair() as CloudflareWebSocketPair;
		const [client, server] = [pair[0], pair[1]];
		
		// Cast to our interface for proper typing
		const serverWs = server as CloudflareWebSocket;
		this.webSocket = serverWs;

		// Accept the WebSocket connection
		serverWs.accept();

		// Set up server-side handlers
		serverWs.addEventListener('message', (event: { data: unknown }) => {
			try {
				if (typeof event.data !== 'string') {
					throw new Error('Expected string data');
				}
				if (event.data.length > MAXIMUM_MESSAGE_SIZE) {
					throw new Error(`Message too large: ${event.data.length} bytes`);
				}
				const message = JSON.parse(event.data);
				void this.handleMessage(message);
			} catch (error) {
				serverWs.send(JSON.stringify({ error: String(error) }));
			}
		});

		serverWs.addEventListener('close', () => {
			this.cleanup();
		});

		serverWs.addEventListener('error', () => {
			this.onerror?.(new Error('Server WebSocket error'));
		});

		// Start keep-alive for server-side connection
		this.startKeepAlive();

		return new Response(null, {
			status: 101,
			headers: {
				'Upgrade': 'websocket',
				'Connection': 'Upgrade'
			},
			// @ts-ignore - Cloudflare-specific property
			webSocket: client
		});
	}
}
