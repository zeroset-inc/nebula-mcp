import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNebulaMcpServer, runHttp, searchOperationDocs } from "../src/index.ts";
import { operationDocs } from "../src/docs.ts";

async function connectInMemory(server: McpServer): Promise<Client> {
  const client = new Client({ name: "nebula-mcp-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("generated Nebula MCP server", () => {
  test("operation docs include public SDK operations", () => {
    const matches = searchOperationDocs(operationDocs, "memories search", 5);
    expect(matches.some((doc) => doc.operationId === "memories.search")).toBe(true);
  });

  test("lists and calls MCP tools over the protocol", async () => {
    const server = createNebulaMcpServer({
      client: {
        collections: {
          list: async () => [{ id: "collection-1", name: "Test collection" }],
        },
      },
    });
    const client = await connectInMemory(server);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["execute", "search_docs"]);

      const docs = await client.callTool({
        name: "search_docs",
        arguments: { query: "collections list", limit: 3 },
      });
      expect(JSON.stringify(docs.structuredContent)).toContain("collections.list");

      const executed = await client.callTool({
        name: "execute",
        arguments: {
          code: "return await client.collections.list();",
        },
      });
      expect(executed.structuredContent).toEqual({
        elapsed_ms: expect.any(Number),
        result: [{ id: "collection-1", name: "Test collection" }],
      });
      const content = executed.content as Array<{ type: string; text?: string }>;
      expect(String(content[0]?.type === "text" ? content[0].text : "")).toContain("Result preview:");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects oversized execute results", async () => {
    const server = createNebulaMcpServer({
      maxResultBytes: 16,
      client: {},
    });
    const client = await connectInMemory(server);

    try {
      const result = await client.callTool({
        name: "execute",
        arguments: {
          code: "return { value: 'this is too large' };",
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("exceeding maxResultBytes=16");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("serves MCP over Streamable HTTP", async () => {
    const http = await runHttp({
      port: 0,
      clientFactory: () => ({
        client: {
          health: async () => ({ status: "ok" }),
        },
      }),
    });
    const client = new Client({ name: "nebula-mcp-http-test-client", version: "0.0.0" });

    try {
      const unauthenticated = await fetch(http.url, { method: "POST", body: "{}" });
      expect(unauthenticated.status).toBe(401);

      // Only `Authorization: Bearer ...` authenticates; other schemes are rejected.
      const nonBearer = await fetch(http.url, {
        method: "POST",
        headers: {
          Authorization: "Basic test-token",
        },
        body: "{}",
      });
      expect(nonBearer.status).toBe(401);

      await client.connect(new StreamableHTTPClientTransport(new URL(http.url), {
        requestInit: {
          headers: {
            Authorization: "Bearer test-token",
          },
        },
      }));
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["execute", "search_docs"]);

      const executed = await client.callTool({
        name: "execute",
        arguments: {
          code: "return await client.client.health();",
        },
      });
      expect((executed.structuredContent as { result?: unknown } | undefined)?.result).toEqual({ status: "ok" });
    } finally {
      await client.close();
      await http.close();
    }
  });

  test("passes an abort signal into execute code on timeout", async () => {
    let observedAbort = false;
    const server = createNebulaMcpServer({
      client: {
        waitForAbort: (signal: AbortSignal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              observedAbort = true;
              resolve("aborted");
            }, { once: true });
          }),
      },
    });
    const client = await connectInMemory(server);

    try {
      const result = await client.callTool({
        name: "execute",
        arguments: {
          timeout_ms: 1,
          code: "return await client.waitForAbort(signal);",
        },
      });
      expect(result.isError).toBe(true);
      expect(observedAbort).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("terminates synchronous execute code on timeout", async () => {
    const server = createNebulaMcpServer({
      apiKey: "test-key",
    });
    const client = await connectInMemory(server);

    try {
      const result = await client.callTool({
        name: "execute",
        arguments: {
          timeout_ms: 25,
          code: "while (true) {}",
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("execute timed out after 25ms");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("does not expose parent process environment in worker execute", async () => {
    process.env.NEBULA_MCP_TEST_SECRET = "should-not-leak";
    const server = createNebulaMcpServer({
      apiKey: "test-key",
      baseUrl: "https://api.example.test",
    });
    const client = await connectInMemory(server);

    try {
      const result = await client.callTool({
        name: "execute",
        arguments: {
          code: [
            "return {",
            "  envSecret: env.NEBULA_MCP_TEST_SECRET ?? null,",
            "  processSecret: process.env.NEBULA_MCP_TEST_SECRET ?? null,",
            "  baseUrl: env.NEBULA_BASE_URL ?? null,",
            "};",
          ].join("\n"),
        },
      });
      expect((result.structuredContent as { result?: unknown } | undefined)?.result).toEqual({
        envSecret: null,
        processSecret: null,
        baseUrl: "https://api.example.test",
      });
    } finally {
      delete process.env.NEBULA_MCP_TEST_SECRET;
      await client.close();
      await server.close();
    }
  });
});
