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

MCP servers support two methods of Bearer token authentication:

1. HTTP Authorization Header (default for all requests)
2. URL Parameter (only for SSE/EventSource connections)

Here's how to configure authentication:

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
1. Check for authentication in this order:
   - Authorization header (`Bearer your-token`)
   - URL parameter for SSE connections (`?token=your-token`)
2. Verify the token format is correct
3. Validate the token using either the fixed token or your custom validation function
4. Return a 401 Unauthorized response if validation fails

### Client Usage

For regular HTTP requests, include a valid Bearer token in the Authorization header:

```javascript
fetch('https://your-worker.workers.dev/', {
  headers: {
    'Authorization': 'Bearer your-secret-token'
  }
})
```

For SSE/EventSource connections, you can use either the header method or append the token as a URL parameter:

```javascript
// Method 1: Using Authorization header
const events = new EventSource('https://your-worker.workers.dev/events', {
  headers: {
    'Authorization': 'Bearer your-secret-token'
  }
});

// Method 2: Using URL parameter (recommended for SSE clients)
const events = new EventSource('https://your-worker.workers.dev/events?token=your-secret-token');
```

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
