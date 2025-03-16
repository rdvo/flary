# Flary

[![npm version](https://img.shields.io/npm/v/flary.svg)](https://www.npmjs.com/package/flary)
[![license](https://img.shields.io/npm/l/flary.svg)](https://github.com/your-repo/flary/blob/main/LICENSE)

A versatile toolkit for building and managing Cloudflare Workers applications, including AI integrations, project scaffolding, and component management.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Features](#features)
- [CLI Usage](#cli-usage)
  - [Project Initialization](#project-initialization)
  - [v0.dev Component Import](#v0dev-component-import)
- [Deployment](#deployment)
- [MCP Integration](#mcp-integration)
  - [Basic Usage](#basic-usage)
  - [Authentication](#authentication)
  - [Connection Types](#connection-types)
  - [Cursor Integration](#cursor-integration)
  - [No Authentication](#no-authentication)
  - [Durable Objects Setup](#durable-objects-setup)
- [License](#license)

---

## Prerequisites

Before you begin, ensure you have:

1. Node.js 18.x or later installed
2. A Cloudflare account
3. Wrangler CLI installed and configured:
   ```bash
   npm install -g wrangler
   wrangler login
   ```

---

## Installation

```bash
npm install flary
```

---

## Features

- 🚀 **Project Scaffolding**: Quickly set up modern Cloudflare Workers projects.
- 🎨 **Component Management**: Import and organize components from v0.dev.
- 🤖 **AI Integration**: Tools and utilities for AI applications.
- 🔒 **Secure MCP Integration**: Model Context Protocol integration with robust authentication.

---

## CLI Usage

### Project Initialization

Create a new Flary project interactively:

```bash
flary init
```

This command will:

- Prompt for your project name.
- Allow template selection (e.g., Full-Stack React App).
- Set up a complete project structure.
- Configure dependencies and Wrangler automatically.

Follow the provided steps after creation:

1. Navigate to your project:

   ```bash
   cd your-project-name
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Start development server:
   ```bash
   npm run dev
   ```

### v0.dev Component Import

Import and organize components from v0.dev:

```bash
# Default directory (src/components)
flary v0 "https://v0.dev/chat/your-component-url"

# Custom directory
flary v0 --dir game-components "https://v0.dev/chat/your-component-url"
```

Options:

- `-d, --dir <directory>`: Specify target subdirectory (relative to `src/`).
- `-h, --help`: Display help information.

---

## Deployment

Deploy your Flary application to Cloudflare Workers:

1. Build your application:

   ```bash
   npm run build
   ```

2. Deploy to Cloudflare Workers:
   ```bash
   npm run deploy
   # or directly with wrangler
   wrangler deploy
   ```

Your application will be deployed to `https://<project-name>.<your-subdomain>.workers.dev`

### Environment Variables

Set environment variables for production:

```bash
# Set a secret
wrangler secret put MY_SECRET
# Set a variable in wrangler.toml
wrangler deploy --var MY_VAR=value
```

---

## MCP Integration

### Basic Usage

Initialize MCP instance and register tools:

```typescript
import { z } from "zod";
import { MCP } from "flary";

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

app.tool("calculate_sum", calculateSum);

export default app;
export const { McpObject } = app;
```

### Authentication

Supports Bearer token authentication:

```typescript
const app = new MCP({
  auth: {
    type: "bearer",
    token: "your-secret-token",
    validate: async (token) => token === (await getValidToken()),
  },
});
```

### Connection Types

- **SSE (Server-Sent Events)**: Connect via `/` or `/sse`.
- **WebSockets**: Connect via `/` or `/ws`.

### Cursor Integration

Cursor uses SSE exclusively:

```bash
https://your-worker.workers.dev/?key=your-secret-token
```

### No Authentication

Publicly accessible MCP server:

```typescript
const app = new MCP({
  name: "test-mcp",
  description: "A test MCP",
  version: "1.0.0",
});
```

### Durable Objects Setup

MCP requires Durable Objects for state management. Configure them in your `wrangler.json`:

```json
{
  "durable_objects": {
    "bindings": [{ "name": "McpObject", "class_name": "McpObject" }]
  },
  "migrations": [{ "tag": "v1", "new_classes": ["McpObject"] }]
}
```

Make sure to export the `McpObject` from your worker entry point as shown in the Basic Usage example.

---

## License

MIT © [flary](https://flary.dev/license)
