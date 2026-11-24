/**
 * LangChain.js tools from the protogrid MCP registry: the tools of MCP servers that pass your rules, connected
 * directly (no proxy in between), plus two tools that let the agent search the registry and check a server itself.
 */
import type { CallToolResult } from "@modelcontextprotocol/client";
import { DynamicStructuredTool } from "@langchain/core/tools";
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

const CLIENT = { name: "protogrid-langchain", version: "0.1.1" };

export type LoadToolsOptions = Omit<LoadOptions, "clientInfo">;

/** Where a loaded tool comes from. */
export interface ToolOrigin {
  server: string;
  /** The tool's own name on the server. */
  tool: string;
  /** The hash of the tool set protogrid checked. */
  toolsHash: string | null;
}

export interface ProtogridTools {
  /** Pass to `createAgent({ tools })` or `model.bindTools`. Named `<server key>_<tool>`. */
  tools: DynamicStructuredTool[];
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
  const tools: DynamicStructuredTool[] = [];
  const origins: Record<string, ToolOrigin> = {};
  for (const s of servers) {
    for (const t of s.tools) {
      const name = prefixedToolName(s.key, t.name);
      if (name in origins) continue;
      tools.push(mcpTool(name, s, t));
      origins[name] = { server: s.server, tool: t.name, toolsHash: s.toolsHash };
    }
  }
  const close = async () => {
    await Promise.allSettled(servers.map((s) => s.close()));
  };
  return { tools, origins, report, close, [Symbol.asyncDispose]: close };
}

function mcpTool(name: string, server: LoadedServer, t: LoadedServer["tools"][number]): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name,
    description: t.description ?? t.title ?? "",
    schema: { type: "object", properties: {}, ...(t.inputSchema as Record<string, unknown>) },
    responseFormat: "content_and_artifact",
    func: async (input: unknown, _run?: unknown, config?: { signal?: AbortSignal }) =>
      toolContent(
        await server.callTool(
          t.name,
          (input ?? {}) as Record<string, unknown>,
          config?.signal ? { signal: config.signal } : {},
        ),
      ),
  });
}

/** A LangChain message content block. */
export type ContentBlock = { type: "text"; text: string } | { type: "image" | "audio"; mimeType: string; data: string };

/**
 * An MCP tool result as LangChain's `[content, artifact]`: the text when the result is only text, content blocks for
 * images and audio, and the whole MCP result as the artifact. A result the server marks as an error throws, so the
 * agent sees a failed tool call.
 */
export function toolContent(result: CallToolResult): [string | ContentBlock[], CallToolResult] {
  const blocks: ContentBlock[] = [];
  for (const c of result.content ?? []) {
    if (c.type === "text") blocks.push({ type: "text", text: c.text });
    else if (c.type === "image" || c.type === "audio")
      blocks.push({ type: c.type, mimeType: c.mimeType, data: c.data });
    else if (c.type === "resource")
      blocks.push({
        type: "text",
        text:
          "text" in c.resource ? c.resource.text : `[${c.resource.mimeType ?? "binary"} resource ${c.resource.uri}]`,
      });
    else if (c.type === "resource_link")
      blocks.push({ type: "text", text: `[resource ${c.uri}${c.name ? ` (${c.name})` : ""}]` });
  }
  const textOnly = blocks.every((b) => b.type === "text");
  const text = textOnly ? blocks.map((b) => (b as { text: string }).text).join("\n") : null;
  if (result.isError) throw new Error(text || "the tool failed");
  if (blocks.length === 0) return [result.structuredContent ? JSON.stringify(result.structuredContent) : "", result];
  return [text ?? blocks, result];
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
export function searchTool(opts: RegistryToolOptions = {}): DynamicStructuredTool {
  const reg = registryOf(opts);
  return new DynamicStructuredTool({
    name: "protogrid_search",
    description:
      "Find MCP servers by what they do. Returns for each: its registry name, connection class (R0 nothing to set up, R1 needs a key, R2 needs a sign-in, L0 a local package), quality score and flags, whether its owner is verified, and the tools that matched.",
    schema: {
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
    },
    func: async (input: unknown) => {
      const { query, limit } = input as { query: string; limit?: number };
      try {
        return JSON.stringify((await reg.search({ q: query, limit: limit ?? 5 })).results.map(summary));
      } catch (e) {
        if (e instanceof ProtogridError) return JSON.stringify({ error: e.code, status: e.status });
        throw e;
      }
    },
  });
}

/**
 * `protogrid_gate`: whether one MCP server passes the rules given here. The model names the server; it cannot change
 * the rules. The defaults are those of `loadTools`.
 */
export function gateTool(opts: RegistryToolOptions & { rules?: LoadRules } = {}): DynamicStructuredTool {
  const reg = registryOf(opts);
  const rules = loadRules(opts.rules);
  return new DynamicStructuredTool({
    name: "protogrid_gate",
    description:
      "Check whether an MCP server passes the rules its owner set for this agent before using it. Returns pass or fail with every broken rule.",
    schema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "The server's registry name, such as io.github.owner/server, as protogrid_search returns it.",
        },
      },
      required: ["server"],
      additionalProperties: false,
    },
    func: async (input: unknown) => {
      const { server } = input as { server: string };
      try {
        const g = await reg.gate(server, rules);
        return JSON.stringify({
          server: g.server,
          pass: g.pass,
          failed: g.failed.map((f) => f.detail),
          quality_score: g.quality.score,
          connection_class: g.class,
          owner_verified: g.owner_verified,
          tools_hash: g.tools_hash,
        });
      } catch (e) {
        if (e instanceof ProtogridError)
          return JSON.stringify({ server, pass: false, failed: [`registry answered ${e.status} (${e.code})`] });
        throw e;
      }
    },
  });
}
