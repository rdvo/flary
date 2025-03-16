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
- v0.dev component import and organization
- Project scaffolding with modern templates

## CLI Usage

```bash
flary [command]
```

### Available Commands

#### Project Initialization

Create a new Flary project with your preferred template:

```bash
flary init
```

This interactive command will:

1. Ask for your project name
2. Let you choose a template:
   - Full-Stack React App (with Cloudflare Workers)
3. Set up a complete project structure
4. Configure all necessary dependencies

After creation, follow the provided steps to start your development server.

#### v0.dev Component Import

Import and organize components from v0.dev:

```bash
# Import components to default directory (src/components)
flary v0 "https://v0.dev/chat/your-component-url"

# Import to custom directory (relative to src/)
flary v0 --dir game-components "https://v0.dev/chat/your-component-url"
```

Options:

- `-d, --dir <directory>`: Target subdirectory for components (relative to src/)
- `-h, --help`: Display help information

## MCP Integration

### Basic Usage

```typescript
import { z } from "zod";
import { MCP } from "flary";

// Initialize MCP instance
const app = new MCP({
  name: "test-mcp",
  description: "A test MCP",
  version: "1.0.0",
});

const sumSchema = z
  .object({
    a: z.number().describe("The first number to add"),
    b: z.number().describe("The second number to add"),
  })
  .describe("Calculate the sum of two numbers");

async function calculateSum({ a, b }: z.input<typeof sumSchema>) {
  return a + b;
}
calculateSum.schema = sumSchema;

// Register the tool using just the function
app.tool("calculate_sum", calculateSum);

// Export the app - it includes the McpObject directly
export default app;
export const { McpObject } = app;
```

### Authentication

#### Bearer Token Authentication

Currently, MCP servers support Bearer token authentication:

```typescript
const app = new MCP({
  name: "test-mcp",
  description: "A test MCP",
  version: "1.0.0",
  auth: {
    type: "bearer",
    // Option 1: Specify a fixed token
    token: "your-secret-token",
    // OR Option 2: Use a custom validation function
    validate: async (token) => {
      // Implement your custom token validation logic
      // Examples:
      // - Query a database
      // - Call an external auth service
      // - Verify a JWT
      return token === (await getValidToken());
    },
  },
});
```

When authentication is enabled, your MCP server will:

1. Check every incoming request for the Authorization header or the `key` query parameter
2. Verify the token format is correct (`Bearer your-token` in header or `key=your-token` in URL)
3. Validate the token using either the fixed token or your custom validation function
4. Return a 401 Unauthorized response if validation fails

#### Client Authentication Methods

```javascript
// Using Authorization header
fetch("https://your-worker.workers.dev/", {
  headers: {
    Authorization: "Bearer your-secret-token",
  },
});

// Using query parameter
fetch("https://your-worker.workers.dev/?key=your-secret-token");
```

#### For SSE/EventSource connections:

```javascript
// Method 1: Using URL parameter (recommended for SSE clients)
const events = new EventSource(
  "https://your-worker.workers.dev/?key=your-secret-token"
);

// Note: Many EventSource implementations don't support custom headers,
// so using the URL parameter method is recommended for SSE
```

#### For WebSocket connections:

```javascript
// Using URL parameter
const socket = new WebSocket(
  "wss://your-worker.workers.dev/?key=your-secret-token"
);

// Some WebSocket implementations support headers
const socket = new WebSocket("wss://your-worker.workers.dev/");
socket.setRequestHeader("Authorization", "Bearer your-secret-token");
```

### Connection Types

The MCP server supports the following connection methods:

- **SSE (Server-Sent Events)**:

  - Connect to the root path (`/`) or `/sse` with proper Accept headers
  - For clients like Cursor that only support SSE, use the URL parameter for auth: `/?key=your-token`

- **WebSockets**:
  - Connect to the root path (`/`) or `/ws` with WebSocket upgrade headers
  - Use URL parameter for auth: `/?key=your-token`

For both connection types, you'll receive a `sessionId` which should be included in subsequent connections.

### Cursor Integration

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
  name: "test-mcp",
  description: "A test MCP",
  version: "1.0.0",
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

## License

MIT
