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
