# Nebula MCP Server

Generated MCP server for the Nebula TypeScript SDK.

## Usage

```bash
export NEBULA_API_KEY="your_api_key_here"
npx -y @nebula-ai/sdk-mcp@latest
```

For Streamable HTTP:

```bash
npx -y @nebula-ai/sdk-mcp@latest --transport=http --port=3000
```

HTTP mode authenticates each request with `Authorization: Bearer ...`.
Environment credentials are used only for stdio mode.

The server exposes:

- `search_docs`: search generated Nebula SDK operation docs.
- `execute`: run JavaScript against an authenticated `@nebula-ai/sdk` client.

`execute` runs trusted user code in a terminated Worker by default for stdio/HTTP server usage. The Worker is a timeout boundary, not a security sandbox; only expose HTTP mode to trusted callers. Programmatic injected clients run in-process and are for trusted embedders.

Set `NEBULA_BASE_URL` to target a non-default API host.
