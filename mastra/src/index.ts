/**
 * Mastra tools from the protogrid MCP registry: the tools of MCP servers that pass your rules, connected directly (no
 * proxy in between), plus two tools that let the agent search the registry and check a server itself.
 */
import type { CallToolResult } from "@modelcontextprotocol/client";
import { createTool } from "@mastra/core/tools";
import {
  createClient,
  LoadReport,
  loadRules,
  loadServers,
  prefixedToolName,
  ProtogridError,
  type LoadedServer,
  type LoadOptions,
  type LoadRules,
  type ProtogridClient,
  type SearchResult,
} from "@protogrid/sdk";

export { LoadReport, NoServerLoaded, type LoadRules, type Skipped } from "@protogrid/sdk";

const CLIENT = { name: "protogrid-mastra", version: "0.1.1" };

export type LoadToolsOptions = Omit<LoadOptions, "clientInfo">;

// The tool type createTool returns for the schemas used here, named once so declarations stay portable.
type MastraTool = ReturnType<typeof createTool>;

/** Where a loaded tool comes from. */
export interface ToolOrigin {
  server: string;
  /** The tool's own name on the server. */
  tool: string;
  /** The hash of the tool set protogrid checked. */
  toolsHash: string | null;
}

export interface ProtogridTools {
  /** Pass as an Agent's `tools`. Named `<server key>_<tool>`. */
  tools: Record<string, MastraTool>;
  origins: Record<string, ToolOrigin>;
  report: LoadReport;
  /** Closes the connection to every loaded server. Also runs on `await using`. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * The tools of up to `maxServers` MCP servers that pass `rules`. Give a `query` (the best `candidates` search results
 * are tried in order) or `servers` by registry name. Each server goes through protogrid's gate with your rules; one
 * that passes is connected to directly, with the `${NAME}` placeholders of its connection filled from `secrets` (they
 * never leave your process). Throws `NoServerLoaded` when none could be loaded; close the result when you are done.
 */
export async function loadTools(opts: LoadToolsOptions): Promise<ProtogridTools> {
  const report = opts.report ?? new LoadReport();
  const servers = await loadServers({ ...opts, report, clientInfo: CLIENT });
  const tools: Record<string, MastraTool> = {};
  const origins: Record<string, ToolOrigin> = {};
  for (const s of servers) {
    for (const t of s.tools) {
      const id = prefixedToolName(s.key, t.name);
      if (id in tools) continue;
      tools[id] = mcpTool(id, s, t);
      origins[id] = { server: s.server, tool: t.name, toolsHash: s.toolsHash };
    }
  }
  const close = async () => {
    await Promise.allSettled(servers.map((s) => s.close()));
  };
  return { tools, origins, report, close, [Symbol.asyncDispose]: close };
}

function mcpTool(id: string, server: LoadedServer, t: LoadedServer["tools"][number]): MastraTool {
  return createTool({
    id,
    description: t.description ?? t.title ?? "",
    inputSchema: { type: "object", properties: {}, ...(t.inputSchema as Record<string, unknown>) } as never,
    execute: async (input, ctx) =>
      toolOutput(
        await server.callTool(
          t.name,
          (input ?? {}) as Record<string, unknown>,
          ctx?.abortSignal ? { signal: ctx.abortSignal } : {},
        ),
      ),
  }) as MastraTool;
}

/**
 * An MCP tool result as the agent sees it: the text when the result is only text, the result itself otherwise. A
 * result the server marks as an error throws, so the agent sees a failed tool call.
 */
export function toolOutput(result: CallToolResult): unknown {
  const content = result.content ?? [];
  const text = content.every((c) => c.type === "text")
    ? content.map((c) => (c as { text: string }).text).join("\n")
    : null;
  if (result.isError) throw new Error(text || "the tool failed");
  if (text !== null && content.length > 0) return text;
  return content.length === 0 && result.structuredContent ? result.structuredContent : result;
}

export interface RegistryToolOptions {
  /** The registry client; one is built from `apiKey` (or `PROTOGRID_API_KEY`) and `baseUrl` otherwise. */
  registry?: ProtogridClient;
  apiKey?: string;
  baseUrl?: string;
}

const registryOf = (o: RegistryToolOptions) =>
  o.registry ?? createClient({ apiKey: o.apiKey, baseUrl: o.baseUrl, userAgent: `${CLIENT.name}/${CLIENT.version}` });

function summary(r: SearchResult) {
  return {
    name: r.name,
    title: r.title ?? null,
    description: (r.description ?? "").slice(0, 300),
    connection_class: r.connection_class,
    quality_score: r.quality_score ?? null,
    quality_flags: r.quality_flags ?? [],
    owner_verified: r.owner_verified ?? false,
    tools: (r.matched_tools ?? []).map((t) => t.name).slice(0, 5),
  };
}

/** `protogrid_search`: finds MCP servers by what they do, with what decides the choice for each. */
export function searchTool(opts: RegistryToolOptions = {}): MastraTool {
  const reg = registryOf(opts);
  return createTool({
    id: "protogrid_search",
    description:
      "Find MCP servers by what they do. Returns for each: its registry name, connection class (R0 nothing to set up, R1 needs a key, R2 needs a sign-in, L0 a local package), quality score and flags, whether its owner is verified, and the tools that matched.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What the MCP server should do, in plain words, such as 'send an email' or 'query a postgres database'.",
        },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "How many servers to return." },
      },
      required: ["query"],
      additionalProperties: false,
    } as never,
    execute: async (input) => {
      const { query, limit } = input as { query: string; limit?: number };
      try {
        return (await reg.search({ q: query, limit: limit ?? 5 })).results.map(summary);
      } catch (e) {
        if (e instanceof ProtogridError) return { error: e.code, status: e.status };
        throw e;
      }
    },
  }) as MastraTool;
}

/**
 * `protogrid_gate`: whether one MCP server passes the rules given here. The model names the server; it cannot change
 * the rules. The defaults are those of `loadTools`.
 */
export function gateTool(opts: RegistryToolOptions & { rules?: LoadRules } = {}): MastraTool {
  const reg = registryOf(opts);
  const rules = loadRules(opts.rules);
  return createTool({
    id: "protogrid_gate",
    description:
      "Check whether an MCP server passes the rules its owner set for this agent before using it. Returns pass or fail with every broken rule.",
    inputSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "The server's registry name, such as io.github.owner/server, as protogrid_search returns it.",
        },
      },
      required: ["server"],
      additionalProperties: false,
    } as never,
    execute: async (input) => {
      const { server } = input as { server: string };
      try {
        const g = await reg.gate(server, rules);
        return {
          server: g.server,
          pass: g.pass,
          failed: g.failed.map((f) => f.detail),
          quality_score: g.quality.score,
          connection_class: g.class,
          owner_verified: g.owner_verified,
          tools_hash: g.tools_hash,
        };
      } catch (e) {
        if (e instanceof ProtogridError)
          return { server, pass: false, failed: [`registry answered ${e.status} (${e.code})`] };
        throw e;
      }
    },
  }) as MastraTool;
}
