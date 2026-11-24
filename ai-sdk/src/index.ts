/**
 * Vercel AI SDK tools from the protogrid MCP registry: the tools of MCP servers that pass your rules, connected
 * directly (no proxy in between), plus two tools that let the agent search the registry and check a server itself.
 */
import type { CallToolResult } from "@modelcontextprotocol/client";
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
import { dynamicTool, jsonSchema, tool, type JSONSchema7, type Tool, type ToolSet } from "ai";

export { LoadReport, NoServerLoaded, type LoadRules, type Skipped } from "@protogrid/sdk";

const CLIENT = { name: "protogrid-ai-sdk", version: "0.1.1" };

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
  /** Pass to `generateText`, `streamText` or an `Agent`. Named `<server key>_<tool>`. */
  tools: ToolSet;
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
  const tools: ToolSet = {};
  const origins: Record<string, ToolOrigin> = {};
  for (const s of servers) {
    for (const t of s.tools) {
      const name = prefixedToolName(s.key, t.name);
      if (name in tools) continue;
      tools[name] = mcpTool(s, t);
      origins[name] = { server: s.server, tool: t.name, toolsHash: s.toolsHash };
    }
  }
  const close = async () => {
    await Promise.allSettled(servers.map((s) => s.close()));
  };
  return { tools, origins, report, close, [Symbol.asyncDispose]: close };
}

function mcpTool(server: LoadedServer, t: LoadedServer["tools"][number]): Tool {
  return dynamicTool({
    description: t.description ?? t.title ?? "",
    inputSchema: jsonSchema({ type: "object", properties: {}, ...(t.inputSchema as JSONSchema7) }),
    execute: (input, { abortSignal }) =>
      server.callTool(t.name, (input ?? {}) as Record<string, unknown>, abortSignal ? { signal: abortSignal } : {}),
    toModelOutput: ({ output }) => toModelOutput(output as CallToolResult),
  });
}

type ModelOutput = ReturnType<NonNullable<Tool["toModelOutput"]>> extends infer R ? Awaited<R> : never;
type ContentPart = Extract<ModelOutput, { type: "content" }>["value"][number];

/** An MCP tool result as the model sees it: text and files as content, an error as error text. */
export function toModelOutput(result: CallToolResult): ModelOutput {
  const parts: ContentPart[] = [];
  for (const c of result.content ?? []) {
    if (c.type === "text") parts.push({ type: "text", text: c.text });
    else if (c.type === "image" || c.type === "audio")
      parts.push({ type: "file", data: { type: "data", data: c.data }, mediaType: c.mimeType });
    else if (c.type === "resource")
      parts.push({
        type: "text",
        text:
          "text" in c.resource ? c.resource.text : `[${c.resource.mimeType ?? "binary"} resource ${c.resource.uri}]`,
      });
    else if (c.type === "resource_link")
      parts.push({ type: "text", text: `[resource ${c.uri}${c.name ? ` (${c.name})` : ""}]` });
  }
  if (result.isError)
    return {
      type: "error-text",
      value: parts.map((p) => (p.type === "text" ? p.text : "")).join("\n") || "the tool failed",
    };
  if (parts.length === 0)
    return result.structuredContent
      ? { type: "json", value: result.structuredContent as never }
      : { type: "text", value: "" };
  return { type: "content", value: parts };
}

export interface RegistryToolOptions {
  /** The registry client; one is built from `apiKey` (or `PROTOGRID_API_KEY`) and `baseUrl` otherwise. */
  registry?: ProtogridClient;
  apiKey?: string;
  baseUrl?: string;
}

const registryOf = (o: RegistryToolOptions) =>
  o.registry ?? createClient({ apiKey: o.apiKey, baseUrl: o.baseUrl, userAgent: `${CLIENT.name}/${CLIENT.version}` });
const failure = (e: unknown): RegistryFailure => {
  if (e instanceof ProtogridError) return { error: e.code, status: e.status };
  throw e;
};

export interface ServerSummary {
  name: string;
  title: string | null;
  description: string;
  connection_class: string;
  quality_score: number | null;
  quality_flags: string[];
  owner_verified: boolean;
  tools: string[];
}
export type RegistryFailure = { error: string; status: number };
export interface GateAnswer {
  server: string;
  pass: boolean;
  failed: string[];
  quality_score?: number | null;
  connection_class?: string;
  owner_verified?: boolean;
  tools_hash?: string | null;
}

function summary(r: SearchResult): ServerSummary {
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
export function searchTool(
  opts: RegistryToolOptions = {},
): Tool<{ query: string; limit?: number }, ServerSummary[] | RegistryFailure> {
  const reg = registryOf(opts);
  return tool({
    description:
      "Find MCP servers by what they do. Returns for each: its registry name, connection class (R0 nothing to set up, R1 needs a key, R2 needs a sign-in, L0 a local package), quality score and flags, whether its owner is verified, and the tools that matched.",
    inputSchema: jsonSchema<{ query: string; limit?: number }>({
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
    }),
    execute: async ({ query, limit }): Promise<ServerSummary[] | RegistryFailure> => {
      try {
        return (await reg.search({ q: query, limit: limit ?? 5 })).results.map(summary);
      } catch (e) {
        return failure(e);
      }
    },
  });
}

/**
 * `protogrid_gate`: whether one MCP server passes the rules given here. The model names the server; it cannot change
 * the rules. The defaults are those of `loadTools`.
 */
export function gateTool(opts: RegistryToolOptions & { rules?: LoadRules } = {}): Tool<{ server: string }, GateAnswer> {
  const reg = registryOf(opts);
  const rules = loadRules(opts.rules);
  return tool({
    description:
      "Check whether an MCP server passes the rules its owner set for this agent before using it. Returns pass or fail with every broken rule.",
    inputSchema: jsonSchema<{ server: string }>({
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "The server's registry name, such as io.github.owner/server, as protogrid_search returns it.",
        },
      },
      required: ["server"],
      additionalProperties: false,
    }),
    execute: async ({ server }): Promise<GateAnswer> => {
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
        const f = failure(e);
        return { server, pass: false, failed: [`registry answered ${f.status} (${f.error})`] };
      }
    },
  });
}
