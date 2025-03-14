# Flary

Mixed assortment of tools for Cloudflare Workers.

## Installation

```bash
npm install flary
```

## Features

- MCP (Model Context Protocol) integration for Cloudflare Workers
- Tools for AI applications on Cloudflare
- Utilities for working with Cloudflare Workers

## Usage

```typescript
import { z } from 'zod';
import { MCP } from flary';

// Initialize MCP instance
const app = new MCP({
	name: 'test-mcp',
	description: 'A test MCP',
	version: '1.0.0'
});

const sumSchema = z.object({
	a: z.number().describe('The first number to add'),
	b: z.number().describe('The second number to add')
}).describe('Calculate the sum of two numbers');

async function calculateSum({ a, b }: z.input<typeof sumSchema>) {
	return a + b;
}
calculateSum.schema = sumSchema;

// Register the tool using just the function
app.tool('calculate_sum', calculateSum);

// Export the app - it includes the McpObject directly
export default app;
export const { McpObject } = app;
```

## Authentication for MCP Servers

You can secure your MCP endpoints with authentication to ensure only authorized clients can access your services:

### Bearer Token Authentication

Currently, MCP servers support Bearer token authentication:

```typescript
const app = new MCP({
	name: 'test-mcp',
	description: 'A test MCP',
	version: '1.0.0',
	auth: {
		type: 'bearer',
		// Option 1: Specify a fixed token
		token: 'your-secret-token',
		// OR Option 2: Use a custom validation function
		validate: async (token) => {
			// Implement your custom token validation logic
			// Examples:
			// - Query a database
			// - Call an external auth service
			// - Verify a JWT
			return token === await getValidToken();
		}
	}
});
```

When authentication is enabled, your MCP server will:
1. Check every incoming request for the Authorization header or the `key` query parameter
2. Verify the token format is correct (`Bearer your-token` in header or `key=your-token` in URL)
3. Validate the token using either the fixed token or your custom validation function
4. Return a 401 Unauthorized response if validation fails

### Client Usage

#### For HTTP/Fetch requests:
```javascript
// Using Authorization header
fetch('https://your-worker.workers.dev/', {
  headers: {
    'Authorization': 'Bearer your-secret-token'
  }
})

// Using query parameter
fetch('https://your-worker.workers.dev/?key=your-secret-token')
```

#### For SSE/EventSource connections:
```javascript
// Method 1: Using URL parameter (recommended for SSE clients)
const events = new EventSource('https://your-worker.workers.dev/?key=your-secret-token');

// Note: Many EventSource implementations don't support custom headers,
// so using the URL parameter method is recommended for SSE
```

#### For WebSocket connections:
```javascript
// Using URL parameter
const socket = new WebSocket('wss://your-worker.workers.dev/?key=your-secret-token');

// Some WebSocket implementations support headers
const socket = new WebSocket('wss://your-worker.workers.dev/');
socket.setRequestHeader('Authorization', 'Bearer your-secret-token');
```

### Connection Endpoints

The MCP server supports the following connection methods:

- **SSE (Server-Sent Events)**: 
  - Connect to the root path (`/`) or `/sse` with proper Accept headers
  - For clients like Cursor that only support SSE, use the URL parameter for auth: `/?key=your-token`

- **WebSockets**: 
  - Connect to the root path (`/`) or `/ws` with WebSocket upgrade headers
  - Use URL parameter for auth: `/?key=your-token`

For both connection types, you'll receive a `sessionId` which should be included in subsequent connections.

### Cursor-Specific Integration

To integrate an MCP server with Cursor (which uses SSE exclusively):

1. In your Cursor MCP configuration, set the endpoint URL with authentication:
   ```
   https://your-worker.workers.dev/?key=your-secret-token
   ```

2. Cursor will connect to your MCP server using SSE, and the server will:
   - Generate a `sessionId` if one isn't provided
   - Establish the SSE connection
   - Allow Cursor to call your registered tools

3. For production use with Cursor, always enable authentication with a secure token.

### No Authentication

If you don't specify any auth configuration, your MCP server will be publicly accessible:

```typescript
const app = new MCP({
	name: 'test-mcp',
	description: 'A test MCP',
	version: '1.0.0'
	// No auth = publicly accessible
});
```

## Configuring Durable Objects

To use MCP in your Cloudflare Worker, you need to configure the Durable Object in your `wrangler.json`:

```json
{
  "name": "your-worker",
  "main": "src/index.ts",
  "durable_objects": {
    "bindings": [
      {
        "name": "McpObject",
        "class_name": "McpObject"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_classes": ["McpObject"]
    }
  ]
}
```

Make sure to export the `McpObject` from your worker entry point as shown in the usage example above.

## CLI

```bash
flary [command]
```

## License

MIT 
