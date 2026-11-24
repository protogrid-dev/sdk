/**
 * Load MCP servers that pass your rules, straight from each server (no proxy in between): the shared core of the
 * framework packages (`@protogrid/ai-sdk`, `@protogrid/mastra`), which turn the tools of each loaded server into
 * their framework's own tools. Needs `@modelcontextprotocol/client` 2.x, imported lazily.
 */
import type { CallToolResult, Client, Tool } from "@modelcontextprotocol/client";
import { createClient, ProtogridError, type ProtogridClient } from "./client.js";
import { connectClient, type Secrets } from "./connect.js";
import type { OAuthOptions } from "./oauth.js";
import { placeholdersIn } from "./secrets.js";
import { toolSetHash } from "./tools-hash.js";
import type { ConnectionClass, GateRules, McpServersConnection, QualityFlag, TrustFlag } from "./types.js";

/**
 * The rules a server must pass before an agent may use it, set by whoever runs the agent, never by the model. A rule
 * left out keeps its default. The defaults refuse what no agent should load: tools that hide text from people, tools
 * holding instructions aimed at the model, and servers depending on a package with a known vulnerability; and they
 * allow R0 and R1 servers only. Local packages (L0) are never loaded: they would run third-party code on your machine.
 */
export type LoadRules = GateRules;

export const DEFAULT_LOAD_RULES: Readonly<{
  no_fail: readonly string[];
  exclude_quality_flags: readonly QualityFlag[];
  class: readonly ConnectionClass[];
}> = Object.freeze({
  no_fail: Object.freeze(["tools.hidden_text", "tools.poisoning"]),
  exclude_quality_flags: Object.freeze(["known-vulns"] as QualityFlag[]),
  class: Object.freeze(["R0", "R1"] as ConnectionClass[]),
});

/** `rules` over the defaults, with L0 taken out of the classes. An empty list switches a default off. */
export function loadRules(rules: LoadRules = {}): GateRules {
  const out: GateRules = {
    no_fail: [...(rules.no_fail ?? DEFAULT_LOAD_RULES.no_fail)],
    exclude_quality_flags: [...(rules.exclude_quality_flags ?? DEFAULT_LOAD_RULES.exclude_quality_flags)],
    class: (rules.class ?? DEFAULT_LOAD_RULES.class).filter((c) => c !== "L0"),
  };
  if (rules.min_quality != null) out.min_quality = rules.min_quality;
  if (rules.min_trust != null) out.min_trust = rules.min_trust;
  if (rules.exclude_flags?.length) out.exclude_flags = [...rules.exclude_flags];
  if (rules.owner_verified != null) out.owner_verified = rules.owner_verified;
  if (rules.paid != null) out.paid = rules.paid;
  for (const k of ["no_fail", "exclude_quality_flags"] as const) if (!out[k]?.length) delete out[k];
  // No class left would mean "any class" to the registry.
  if (!out.class?.length) throw new TypeError("rules.class allows no class that can be loaded (L0 never is)");
  return out;
}

export interface LoadOptions {
  /** What the tools should do; the best `candidates` search results are tried in order. Give this or `servers`. */
  query?: string;
  /** Registry names to try in order, instead of a search. */
  servers?: string[];
  rules?: LoadRules;
  /** Values for the `${NAME}` placeholders of a connection. They never leave your process. */
  secrets?: Secrets;
  /** How many servers to load at most (default 1). */
  maxServers?: number;
  /** How many search results to try (default 10). */
  candidates?: number;
  /** Server name to the tool-set hash you reviewed (the gate's `tools_hash`): a server whose checked tools changed since is passed over. */
  pins?: Record<string, string>;
  /** Also require the tools the server lists right now to be the ones protogrid checked. */
  strictTools?: boolean;
  /** Lets R2 servers load (with `"R2"` in `rules.class`): tokens come from the store, consent runs once when needed. */
  oauth?: OAuthOptions;
  /** The registry client; one is built from `apiKey` and `baseUrl` otherwise. */
  registry?: ProtogridClient;
  apiKey?: string;
  baseUrl?: string;
  /** Who connects: sent to the registry as the user agent and to each server as the MCP client info. */
  clientInfo?: { name: string; version: string };
  /** Filled with the servers loaded and passed over, whatever the outcome. */
  report?: LoadReport;
}

export interface Skipped {
  server: string;
  reason: string;
}

/** What `loadServers` did: the servers loaded, with the tool-set hash protogrid checked, and those it passed over. */
export class LoadReport {
  readonly loaded: Record<string, string | null> = {};
  readonly skipped: Skipped[] = [];
}

export class NoServerLoaded extends Error {
  constructor(public readonly report: LoadReport) {
    const reasons = report.skipped.map((s) => `${s.server}: ${s.reason}`).join("; ") || "no candidates";
    super(`no MCP server passed the rules and connected (${reasons})`);
    this.name = "NoServerLoaded";
  }
}

/** One connected server that passed the rules. Close it when the agent is done. */
export interface LoadedServer {
  /** The registry name, such as `io.github.owner/server`. */
  server: string;
  /** The server's short key in its connection, the prefix of its tool names. */
  key: string;
  /** The hash of the tool set protogrid checked; pin it to notice a change. */
  toolsHash: string | null;
  /** The tools the server listed when it connected. */
  tools: Tool[];
  callTool(name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<CallToolResult>;
  close(): Promise<void>;
}

const TOOL_NAME = /[^A-Za-z0-9_-]/g;

/** `<server key>_<tool>`, in the characters and length every chat model accepts for a tool name. */
export function prefixedToolName(key: string, name: string): string {
  return `${key}_${name}`.replace(TOOL_NAME, "_").slice(0, 64);
}

/**
 * Up to `maxServers` MCP servers that pass `rules`, connected. Each candidate goes through protogrid's gate with
 * `rules`; one that passes is connected to directly, with its placeholders filled from `secrets`. A server that needs
 * a secret you did not give, a sign-in your rules or options do not allow, or a local package is passed over, and so
 * is one that cannot be reached. Throws `NoServerLoaded` when none loaded.
 */
export async function loadServers(opts: LoadOptions): Promise<LoadedServer[]> {
  if ((opts.query == null) === (opts.servers == null)) throw new TypeError("give either a query or a list of servers");
  const info = opts.clientInfo ?? { name: "protogrid-sdk", version: "0" };
  const reg =
    opts.registry ??
    createClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, userAgent: `${info.name}/${info.version}` });
  const rules = loadRules(opts.rules);
  const report = opts.report ?? new LoadReport();
  const max = opts.maxServers ?? 1;
  const out: LoadedServer[] = [];
  try {
    const names =
      opts.servers ??
      (
        await reg.search({
          q: opts.query!,
          limit: opts.candidates ?? 10,
          ...(rules.class ? { class: rules.class } : {}),
          ...(rules.paid != null ? { paid: rules.paid } : {}),
          ...(rules.min_quality != null ? { min_quality: rules.min_quality } : {}),
          ...(rules.min_trust != null ? { min_trust: rules.min_trust } : {}),
          ...(rules.owner_verified != null ? { owner_verified: rules.owner_verified } : {}),
          ...(rules.exclude_quality_flags
            ? { exclude_quality_flags: rules.exclude_quality_flags as QualityFlag[] }
            : {}),
          ...(rules.exclude_flags ? { exclude_flags: rules.exclude_flags as TrustFlag[] } : {}),
        })
      ).results.map((r) => r.name);
    for (const server of names) {
      if (out.length >= max) break;
      if (out.some((s) => s.server === server)) continue;
      const loaded = await loadOne(reg, server, rules, opts, info, report);
      if (loaded) out.push(loaded);
    }
  } catch (err) {
    await Promise.allSettled(out.map((s) => s.close()));
    throw err;
  }
  if (out.length === 0) throw new NoServerLoaded(report);
  return out;
}

async function loadOne(
  reg: ProtogridClient,
  server: string,
  rules: GateRules,
  opts: LoadOptions,
  info: { name: string; version: string },
  report: LoadReport,
): Promise<LoadedServer | null> {
  const skip = (reason: string) => {
    report.skipped.push({ server, reason });
    return null;
  };
  const registryError = (e: unknown, what: string) =>
    e instanceof ProtogridError ? `${what} ${e.status} (${e.code})` : null;
  let gate;
  try {
    gate = await reg.gate(server, rules);
  } catch (e) {
    const r = registryError(e, "registry answered");
    if (r) return skip(r);
    throw e;
  }
  if (!gate.pass) return skip(gate.failed.map((f) => f.detail).join("; "));
  const checked = gate.tools_hash;
  const pin = opts.pins?.[server];
  if (pin !== undefined && pin !== checked) return skip(`tools changed since pinned (${pin} is now ${checked})`);
  let conn: McpServersConnection;
  try {
    conn = await reg.getConnection(server, "mcpServers");
  } catch (e) {
    const r = registryError(e, "no connection offered:");
    if (r) return skip(r);
    throw e;
  }
  if (conn.kind !== "remote") return skip("not a remote server (local packages are never loaded)");
  const oauth = conn.class === "R2";
  if (oauth && !opts.oauth) return skip("needs a sign-in (pass oauth to allow it)");
  const secrets = opts.secrets ?? {};
  const missing = neededSecrets(conn, oauth).filter((n) => !secrets[n]);
  if (missing.length) return skip(`needs ${missing.join(", ")}, not in secrets`);

  let client: Client | undefined;
  try {
    client = await newClient(info);
    await connectClient(client, conn, secrets, oauth ? { oauth: opts.oauth } : {});
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    if (opts.strictTools) {
      const live = toolSetHash(tools);
      if (live !== checked) {
        await client.close().catch(() => {});
        return skip(`lists tools other than the ones protogrid checked (${live} against ${checked})`);
      }
    }
    report.loaded[server] = checked;
    const c = client;
    return {
      server,
      key: conn.key,
      toolsHash: checked,
      tools,
      callTool: (toolName, args, o = {}) =>
        c.callTool(
          { name: toolName, arguments: args },
          o.signal ? { signal: o.signal } : undefined,
        ) as Promise<CallToolResult>,
      close: () => c.close(),
    };
  } catch (e) {
    await client?.close().catch(() => {});
    return skip(`could not connect: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
}

/** The placeholders a connection needs. With OAuth the provider sets Authorization itself, so a placeholder there is not needed. */
function neededSecrets(conn: McpServersConnection, oauth: boolean): string[] {
  const entry = conn.connection.mcpServers[conn.key] ?? Object.values(conn.connection.mcpServers)[0];
  if (!entry) return [];
  if (!oauth || !("headers" in entry) || !entry.headers) return placeholdersIn(entry);
  const headers = Object.fromEntries(
    Object.entries(entry.headers).filter(([k]) => k.toLowerCase() !== "authorization"),
  );
  return placeholdersIn({ ...entry, headers });
}

async function newClient(info: { name: string; version: string }): Promise<Client> {
  const { Client } = await import("@modelcontextprotocol/client");
  return new Client(info, { versionNegotiation: { mode: "auto" } });
}
