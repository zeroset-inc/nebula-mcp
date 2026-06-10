#!/usr/bin/env node

import { runHttp, runStdio } from "./index.js";

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

async function main(): Promise<void> {
  const transport = readFlag("transport") ?? "stdio";
  if (transport === "stdio") {
    await runStdio();
    return;
  }

  if (transport === "http") {
    const port = Number(readFlag("port") ?? process.env.PORT ?? "3000");
    const host = readFlag("host") ?? process.env.HOST ?? "127.0.0.1";
    const path = readFlag("path") ?? "/mcp";
    const { url } = await runHttp({ host, port, path });
    console.error(`Nebula MCP server listening on ${url}`);
    return;
  }

  throw new Error(`Unsupported transport "${transport}". Use "stdio" or "http".`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
