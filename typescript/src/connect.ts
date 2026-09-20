/**
 * From a `mcpServers` connection block to a live transport of the official MCP SDK
 * (`@modelcontextprotocol/sdk`, optional peer dependency, imported lazily).
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ProtogridClient, SearchParams } from "./client.js";
import { createOAuthProvider, hasTokens, type OAuthOptions, type TokenStore } from "./oauth.js";
import { placeholdersIn, substituteSecrets } from "./secrets.js";
import type { McpServersConnection, McpServersEntry, SearchResult } from "./types.js";

export type Secrets = Record<string, string | undefined>;

export interface TransportOptions {
  /** Attach OAuth (R2 servers): tokens come from the store, consent runs once when needed. */
  oauth?: OAuthOptions | undefined;
}

/** The single `mcpServers` entry of a connection response, with secrets substituted. */
export function resolveEntry(conn: McpServersConnection, secrets: Secrets = {}): { key: string; entry: McpServersEntry } {
  const key = conn.key;
  const entry = conn.connection.mcpServers[key] ?? Object.values(conn.connection.mcpServers)[0];
  if (!entry) throw new Error(`connection for ${conn.server} has no mcpServers entry`);
  return { key, entry: substituteSecrets(entry, secrets) };
}

function resolveEntryPartial(conn: McpServersConnection, secrets: Secrets): { key: string; entry: McpServersEntry } {
  const entry = conn.connection.mcpServers[conn.key] ?? Object.values(conn.connection.mcpServers)[0];
  if (!entry) throw new Error(`connection for ${conn.server} has no mcpServers entry`);
  return { key: conn.key, entry: substituteSecrets(entry, secrets, { partial: true }) };
}

/** True when every placeholder the connection needs has a value in `secrets`. */
export function secretsSatisfied(conn: McpServersConnection, secrets: Secrets = {}): boolean {
  return placeholdersIn(conn.connection).every((n) => secrets[n] != null);
}

/**
 * Builds a transport for the preferred remote (streamable HTTP / SSE) or package (stdio).
 * Requires `@modelcontextprotocol/sdk` to be installed by the caller. (Casts: the SDK's own
 * types are not written for exactOptionalPropertyTypes.)
 */
export async function createTransport(conn: McpServersConnection, secrets: Secrets = {}, opts: TransportOptions = {}): Promise<Transport> {
  if (conn.kind === "bundle") throw new Error(`${conn.server} is only available as a bundle; no transport can be built`);
  const useOAuth = !!opts.oauth && conn.kind === "remote" && (conn.auth_type === "oauth2" || conn.auth_type === "unknown");
  // With OAuth the provider sets Authorization itself; a publisher-declared `${TOKEN}` placeholder
  // for that header must not block the flow, so substitute partially and drop it if unresolved.
  const { entry } = useOAuth ? resolveEntryPartial(conn, secrets) : resolveEntry(conn, secrets);
  if ("url" in entry) {
    const headers = { ...(entry.headers ?? {}) };
    if (useOAuth) for (const k of Object.keys(headers)) if (k.toLowerCase() === "authorization" && /\$\{[^}]+\}/.test(headers[k]!)) delete headers[k];
    const authProvider = useOAuth ? createOAuthProvider(conn.server, opts.oauth!) : undefined;
    if (entry.type === "sse") {
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      return new SSEClientTransport(new URL(entry.url), {
        requestInit: { headers },
        eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: mergeHeaders(init?.headers, headers) }) },
        ...(authProvider ? { authProvider } : {}),
      }) as unknown as Transport;
    }
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    return new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers }, ...(authProvider ? { authProvider } : {}) }) as unknown as Transport;
  }
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  return new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...filterEnv(process.env), ...(entry.env ?? {}) } }) as unknown as Transport;
}

function mergeHeaders(base: HeadersInit | undefined, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(base).forEach((v, k) => (out[k] = v));
  return { ...out, ...extra };
}

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v != null) out[k] = v;
  return out;
}

/** Minimal shape of an MCP `Client` (or anything that connects a transport). */
export interface Connectable_Client {
  connect(transport: Transport): Promise<void>;
}

/**
 * Connects `client` to a server; for R2 servers runs the one-time consent when the store has
 * no usable tokens, finishes the authorization and reconnects. No human step when tokens exist.
 */
export async function connectClient(client: Connectable_Client, conn: McpServersConnection, secrets: Secrets = {}, opts: TransportOptions = {}): Promise<Transport> {
  const first = await createTransport(conn, secrets, opts);
  try {
    await client.connect(first);
    return first;
  } catch (err) {
    if (!opts.oauth || !isUnauthorized(err)) throw err;
    const code = await opts.oauth.consent.waitForCode();
    await (first as unknown as { finishAuth(code: string): Promise<void> }).finishAuth(code);
    await first.close().catch(() => {});
    const second = await createTransport(conn, secrets, opts);
    await client.connect(second);
    return second;
  }
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof Error && (err.name === "UnauthorizedError" || /unauthorized/i.test(err.message));
}

export interface Connectable {
  result: SearchResult;
  connection: McpServersConnection;
}

/**
 * Searches and returns the first result an agent can connect to right now: R0, or R1 when
 * every required secret is present in `secrets`, or R2 when `tokenStore` already holds tokens
 * for it. Local packages are included only when `allowLocal` is set (they run on the caller's machine).
 */
export async function findConnectable(
  client: ProtogridClient,
  params: SearchParams,
  opts: { secrets?: Secrets; allowLocal?: boolean; maxCandidates?: number; tokenStore?: TokenStore } = {},
): Promise<Connectable | null> {
  const classes = params.class ?? ([...(["R0", "R1"] as const), ...(opts.tokenStore ? (["R2"] as const) : []), ...(opts.allowLocal ? (["L0"] as const) : [])] as const);
  const res = await client.search({ ...params, class: [...classes], limit: params.limit ?? opts.maxCandidates ?? 10 });
  for (const result of res.results) {
    const r2ok = result.connection_class === "R2" && opts.tokenStore ? await hasTokens(opts.tokenStore, result.name) : false;
    if (!result.autonomous && !r2ok && !(opts.allowLocal && result.connection_class === "L0")) continue;
    let connection: McpServersConnection;
    try {
      connection = await client.getConnection(result.name);
    } catch {
      continue;
    }
    if (connection.kind === "bundle") continue;
    if (!secretsSatisfied(connection, opts.secrets)) continue;
    return { result, connection };
  }
  return null;
}
