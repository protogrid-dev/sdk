/**
 * Pure formatters descriptor → framework object (design rule §4). No framework is imported;
 * the shapes are the frameworks' documented config types.
 */
import { resolveEntry, type Secrets } from "./connect.js";
import type { McpServersConnection } from "./types.js";

/** `mcpServers` entry as the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) `query({ options: { mcpServers } })` expects. */
export type ClaudeAgentSdkServer =
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

export function toClaudeAgentSdk(conn: McpServersConnection, secrets: Secrets = {}): Record<string, ClaudeAgentSdkServer> {
  const { key, entry } = resolveEntry(conn, secrets);
  if ("url" in entry) {
    return { [key]: { type: entry.type === "sse" ? "sse" : "http", url: entry.url, ...(entry.headers && Object.keys(entry.headers).length ? { headers: entry.headers } : {}) } };
  }
  return { [key]: { type: "stdio", command: entry.command, args: entry.args, ...(entry.env && Object.keys(entry.env).length ? { env: entry.env } : {}) } };
}

/** Raw transport parameters for hand-built transports of the official MCP SDK. */
export type RawTransportOptions =
  | { kind: "streamable-http" | "sse"; url: URL; requestInit: { headers: Record<string, string> } }
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> };

export function toRawTransport(conn: McpServersConnection, secrets: Secrets = {}): RawTransportOptions {
  const { entry } = resolveEntry(conn, secrets);
  if ("url" in entry) return { kind: entry.type === "sse" ? "sse" : "streamable-http", url: new URL(entry.url), requestInit: { headers: entry.headers ?? {} } };
  return { kind: "stdio", command: entry.command, args: entry.args, env: entry.env ?? {} };
}
