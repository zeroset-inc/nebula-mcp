import { AsyncLocalStorage } from "node:async_hooks";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { operationDocs, type OperationDoc } from "./docs.js";

type JsonRecord = Record<string, unknown>;
type ExecuteIsolation = "worker" | "in-process";

export interface AuthContext {
  apiKey: string;
}

export interface NebulaMcpServerOptions {
  client?: unknown;
  clientFactory?: (auth?: AuthContext) => unknown | Promise<unknown>;
  apiKey?: string;
  baseUrl?: string;
  operationDocs?: OperationDoc[];
  maxResultBytes?: number;
  textPreviewBytes?: number;
  executeIsolation?: ExecuteIsolation;
}

export interface HttpRunOptions extends NebulaMcpServerOptions {
  host?: string;
  port?: number;
  path?: string;
}

export interface ExecuteResult {
  result: unknown;
  elapsed_ms: number;
}

const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_HTTP_PATH = "/mcp";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULT_BYTES = 1_000_000;
const DEFAULT_TEXT_PREVIEW_BYTES = 8_000;
const executionClientStorage = new AsyncLocalStorage<unknown>();

export function createNebulaMcpServer(options: NebulaMcpServerOptions = {}): McpServer {
  const docs = options.operationDocs ?? operationDocs;
  const server = new McpServer(
    {
      name: "nebula-mcp",
      version: "0.0.0-from-source",
      websiteUrl: "https://docs.zeroset.com/mcp-integration",
    },
    {
      instructions:
        "Use search_docs to find Nebula SDK methods, then use execute to run JavaScript against the authenticated client.",
    }
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search Nebula SDK Docs",
      description: "Search generated Nebula API operation docs by method name, endpoint, summary, and schema names.",
      inputSchema: {
        query: z.string().min(1).describe("Search query, for example 'create memory' or 'collections list'."),
        limit: z.number().int().min(1).max(25).optional().default(10),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      const matches = searchOperationDocs(docs, query, limit);
      return {
        content: [
          {
            type: "text",
            text: formatDocMatches(matches),
          },
        ],
        structuredContent: {
          count: matches.length,
          results: matches,
        },
      };
    }
  );

  server.registerTool(
    "execute",
    {
      title: "Execute Nebula SDK Code",
      description:
        "Run trusted JavaScript code with full Node.js access against an authenticated Nebula SDK client. The code runs in an async function with client, env, console, getClient, and signal in scope. Worker mode enforces timeout termination, but is not a security sandbox.",
      inputSchema: {
        code: z.string().min(1).describe("JavaScript code. Return a value explicitly, or use await with the provided client."),
        timeout_ms: z.number().int().min(1).max(120_000).optional().default(DEFAULT_TIMEOUT_MS),
      },
    },
    async ({ code, timeout_ms }) => {
      const started = Date.now();
      const result = await runExecuteCode(code, options, timeout_ms);
      const serialized = serializeResult(result, options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES);
      const payload: ExecuteResult = {
        result: serialized.value,
        elapsed_ms: Date.now() - started,
      };
      return {
        content: [
          {
            type: "text",
            text: formatExecuteText(payload, serialized.json, serialized.bytes, options.textPreviewBytes ?? DEFAULT_TEXT_PREVIEW_BYTES),
          },
        ],
        structuredContent: payload as unknown as JsonRecord,
      };
    }
  );

  return server;
}

export function searchOperationDocs(
  docs: readonly OperationDoc[],
  query: string,
  limit = 10
): OperationDoc[] {
  const terms = tokenize(query);
  if (terms.length === 0) return docs.slice(0, limit);

  return docs
    .map((doc) => ({ doc, score: scoreDoc(doc, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.doc.operationId.localeCompare(b.doc.operationId))
    .slice(0, limit)
    .map(({ doc }) => doc);
}

function formatDocMatches(matches: readonly OperationDoc[]): string {
  if (matches.length === 0) {
    return "No matching Nebula SDK operations found.";
  }

  return matches
    .map((doc) => {
      const params = doc.parameters
        .map((param) => `${param.name}${param.required ? "" : "?"}:${param.in}`)
        .join(", ");
      const body = doc.requestBody ? ` body:${doc.requestBody.schema}${doc.requestBody.required ? "" : "?"}` : "";
      const response = doc.response
        ? ` -> ${doc.response.unwrapsTo ?? doc.response.schema}`
        : "";
      return [
        `${doc.operationId} - ${doc.summary || doc.method + " " + doc.path}`,
        `  endpoint: ${doc.method} ${doc.path}`,
        params || body ? `  inputs: ${[params, body.trim()].filter(Boolean).join(" ")}` : undefined,
        response ? `  response:${response}` : undefined,
        doc.description ? `  description: ${doc.description.replace(/\s+/g, " ").trim()}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export async function runStdio(options: NebulaMcpServerOptions = {}): Promise<void> {
  const server = createNebulaMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function runHttp(options: HttpRunOptions = {}): Promise<{
  close: () => Promise<void>;
  url: string;
}> {
  const host = options.host ?? DEFAULT_HTTP_HOST;
  const port = options.port ?? DEFAULT_HTTP_PORT;
  const path = options.path ?? DEFAULT_HTTP_PATH;

  const httpServer = createHttpServer(async (req, res) => {
    if (!req.url || new URL(req.url, `http://${host}:${port}`).pathname !== path) {
      writeJsonRpcError(res, 404, "Not found");
      return;
    }
    if (req.method !== "POST") {
      writeJsonRpcError(res, 405, "Method not allowed");
      return;
    }

    const auth = authFromRequest(req);
    if (!auth) {
      writeJsonRpcError(res, 401, "Missing Authorization bearer token");
      return;
    }

    const clientFactory = options.clientFactory;
    const server = createNebulaMcpServer({
      ...options,
      client: undefined,
      apiKey: auth.apiKey,
      clientFactory: clientFactory ? () => clientFactory(auth) : undefined,
    });
    const transport = new StreamableHTTPServerTransport({
      // HTTP requests are stateless so each request is scoped to its Bearer credential.
      sessionIdGenerator: undefined,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, error instanceof Error ? error.message : "Internal server error");
      }
    } finally {
      await transport.close();
      await server.close();
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo;
  const actualHost = address.address === "::" ? "127.0.0.1" : address.address;
  const actualPort = address.port;

  return {
    close: () =>
      new Promise((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
    url: `http://${actualHost}:${actualPort}${path}`,
  };
}

async function resolveClient(options: NebulaMcpServerOptions): Promise<unknown> {
  if (options.client !== undefined) return options.client;
  if (options.clientFactory) return await options.clientFactory();

  const mod = await import("@nebula-ai/sdk");
  const Nebula = nebulaConstructorFromModule(mod);
  if (!Nebula) {
    throw new Error("@nebula-ai/sdk did not export a Nebula client constructor");
  }

  const apiKey = options.apiKey ?? process.env.NEBULA_API_KEY;
  if (!apiKey) {
    throw new Error("Set NEBULA_API_KEY before using execute");
  }

  return new Nebula({
    apiKey,
    baseUrl: options.baseUrl ?? process.env.NEBULA_BASE_URL,
  });
}

function nebulaConstructorFromModule(mod: unknown): (new (options: { apiKey: string; baseUrl?: string }) => unknown) | null {
  const record = mod as Record<string, unknown>;
  const defaultExport = record.default as Record<string, unknown> | undefined;
  for (const candidate of [
    record.default,
    record.Nebula,
    record.NebulaClient,
    defaultExport?.default,
    defaultExport?.Nebula,
    defaultExport?.NebulaClient,
  ]) {
    if (typeof candidate === "function") return candidate as new (options: { apiKey: string; baseUrl?: string }) => unknown;
  }
  return null;
}

async function runExecuteCode(
  code: string,
  options: NebulaMcpServerOptions,
  timeoutMs: number
): Promise<unknown> {
  const isolation = options.executeIsolation ?? (hasInjectedClient(options) ? "in-process" : "worker");
  if (isolation === "worker") {
    if (hasInjectedClient(options)) {
      throw new Error("executeIsolation='worker' cannot be used with an injected client or clientFactory");
    }
    return await runClientCodeInWorker(code, options, timeoutMs);
  }

  const client = await resolveClient(options);
  return await withTimeout((signal) => runClientCode(code, client, signal, safeExecuteEnv(options)), timeoutMs);
}

function hasInjectedClient(options: NebulaMcpServerOptions): boolean {
  return options.client !== undefined || options.clientFactory !== undefined;
}

async function runClientCode(
  code: string,
  client: unknown,
  signal: AbortSignal,
  env: Readonly<Record<string, string>>
): Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<unknown>;
  const fn = new AsyncFunction(
    "client",
    "env",
    "console",
    "getClient",
    "signal",
    `"use strict";\n${code}`
  );
  return await executionClientStorage.run(client, () =>
    fn(client, env, console, () => executionClientStorage.getStore(), signal)
  );
}

async function runClientCodeInWorker(
  code: string,
  options: NebulaMcpServerOptions,
  timeoutMs: number
): Promise<unknown> {
  const apiKey = options.apiKey ?? process.env.NEBULA_API_KEY;
  if (!apiKey) {
    throw new Error("Set NEBULA_API_KEY before using execute");
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    const workerOptions: WorkerOptions & { type: "module" } = {
      eval: true,
      type: "module",
      env: safeExecuteEnv(options),
      workerData: {
        code,
        apiKey,
        baseUrl: options.baseUrl ?? process.env.NEBULA_BASE_URL,
        sdkImportSpecifier: resolveSdkImportSpecifier(),
        timeoutMs,
      },
    };
    const worker = new Worker(EXECUTE_WORKER_SOURCE, workerOptions);

    const timeoutId = setTimeout(() => {
      settle(() => reject(new Error(`execute timed out after ${timeoutMs}ms`)));
      void worker.terminate();
    }, timeoutMs);

    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      finish();
    };

    worker.once("message", (message: WorkerResponse) => {
      settle(() => {
        void worker.terminate();
        if (message.ok) {
          resolve(message.result);
        } else {
          reject(errorFromWorker(message.error));
        }
      });
    });
    worker.once("error", (error) => {
      settle(() => reject(error));
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        settle(() => reject(new Error(`execute worker exited with code ${code}`)));
      }
    });
  });
}

function safeExecuteEnv(options: NebulaMcpServerOptions): Record<string, string> {
  const env: Record<string, string> = {};
  const baseUrl = options.baseUrl ?? process.env.NEBULA_BASE_URL;
  if (baseUrl) env.NEBULA_BASE_URL = baseUrl;
  return Object.freeze(env);
}

function resolveSdkImportSpecifier(): string {
  if (typeof __filename === "string") {
    return pathToFileURL(createRequire(__filename).resolve("@nebula-ai/sdk")).href;
  }
  return typeof import.meta.resolve === "function" ? import.meta.resolve("@nebula-ai/sdk") : "@nebula-ai/sdk";
}

interface WorkerError {
  name?: string;
  message?: string;
  status?: unknown;
  type?: unknown;
  requestId?: unknown;
  code?: unknown;
}

type WorkerResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: WorkerError };

function errorFromWorker(details: WorkerError): Error {
  const error = new Error(details.message || "execute failed");
  if (details.name) error.name = details.name;
  for (const key of ["status", "type", "requestId", "code"] as const) {
    if (details[key] !== undefined) {
      Object.defineProperty(error, key, {
        value: details[key],
        enumerable: true,
        configurable: true,
      });
    }
  }
  return error;
}

const EXECUTE_WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";

function serializeError(error) {
  if (!error || typeof error !== "object") {
    return { message: String(error) };
  }
  return {
    name: typeof error.name === "string" ? error.name : undefined,
    message: typeof error.message === "string" ? error.message : String(error),
    status: error.status,
    type: error.type,
    requestId: error.requestId,
    code: error.code,
  };
}

function nebulaConstructorFromModule(mod) {
  const defaultExport = mod.default;
  for (const candidate of [
    mod.default,
    mod.Nebula,
    mod.NebulaClient,
    defaultExport && defaultExport.default,
    defaultExport && defaultExport.Nebula,
    defaultExport && defaultExport.NebulaClient,
  ]) {
    if (typeof candidate === "function") return candidate;
  }
  return null;
}

(async () => {
  const { code, apiKey, baseUrl, sdkImportSpecifier, timeoutMs } = workerData;
  const mod = await import(sdkImportSpecifier);
  const Nebula = nebulaConstructorFromModule(mod);
  if (!Nebula) {
    throw new Error("@nebula-ai/sdk did not export a Nebula client constructor");
  }

  const client = new Nebula({ apiKey, baseUrl });
  const env = Object.freeze({ ...process.env });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(
      "client",
      "env",
      "console",
      "getClient",
      "signal",
      '"use strict";\\n' + code
    );
    const result = await fn(client, env, console, () => client, controller.signal);
    parentPort.postMessage({ ok: true, result });
  } finally {
    clearTimeout(timeoutId);
  }
})().catch((error) => {
  parentPort.postMessage({ ok: false, error: serializeError(error) });
});
`;

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`execute timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function scoreDoc(doc: OperationDoc, terms: readonly string[]): number {
  const operationId = doc.operationId.toLowerCase();
  const resource = doc.resource.toLowerCase();
  const action = doc.action.toLowerCase();
  const haystack = [
    operationId,
    resource,
    action,
    doc.method,
    doc.path,
    doc.summary,
    doc.description,
    doc.requestBody?.schema,
    doc.response?.schema,
    doc.response?.unwrapsTo,
    ...doc.parameters.map((param) => param.name),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (operationId === term) score += 20;
    else if (operationId.includes(term)) score += 10;
    if (resource === term || action === term) score += 6;
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function serializeResult(value: unknown, maxBytes: number): { value: unknown; json: string; bytes: number } {
  let json: string;
  try {
    json = value === undefined ? "null" : JSON.stringify(value);
  } catch {
    json = JSON.stringify(String(value));
  }
  if (json === undefined) json = "null";
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`execute result is ${bytes} bytes, exceeding maxResultBytes=${maxBytes}`);
  }
  return { value: JSON.parse(json), json, bytes };
}

function formatExecuteText(
  payload: ExecuteResult,
  resultJson: string,
  resultBytes: number,
  previewBytes: number
): string {
  const preview = truncateUtf8(resultJson, previewBytes);
  const suffix = preview.truncated ? "\n... result preview truncated; use structuredContent for the complete result." : "";
  return `Execution completed in ${payload.elapsed_ms}ms. Result size: ${resultBytes} bytes.\nResult preview:\n${preview.text}${suffix}`;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  return {
    text: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, ""),
    truncated: true,
  };
}

function authFromRequest(req: IncomingMessage): AuthContext | null {
  const authorization = firstHeader(req.headers.authorization);
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  const apiKey = match?.[1]?.trim();
  if (apiKey) return { apiKey };
  return null;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  const trimmed = header?.trim();
  return trimmed || undefined;
}

function writeJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  if (status === 401) res.setHeader("WWW-Authenticate", "Bearer");
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message,
      },
      id: null,
    })
  );
}
