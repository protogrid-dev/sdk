/**
 * Shared by the tests of @protogrid/sdk and the framework packages: a real MCP server over HTTP on a local port that
 * wants a bearer token, and a scripted registry answering search, gate and connection.
 */
import http from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";

export const TOKEN = "s3cret-" + Math.random().toString(36).slice(2);

export interface MailServer {
  url: string;
  /** The Authorization header of every request the server received. */
  seenAuth: (string | undefined)[];
  close(): Promise<void>;
}

/** Two tools: `send` (needs `to`) and `ping`. Requests without `Bearer TOKEN` get a 401. */
export async function startMailServer(): Promise<MailServer> {
  const factory = () => {
    const mcp = new McpServer({ name: "mail", version: "0" });
    mcp.registerTool(
      "send",
      { description: "Send a test mail.", inputSchema: z.object({ to: z.string() }) },
      async (a) => ({ content: [{ type: "text", text: `sent to ${a.to}` }] }),
    );
    mcp.registerTool("ping", { description: "Answer pong." }, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    return mcp;
  };
  const handler = toNodeHandler(createMcpHandler(factory, { legacy: "stateless", responseMode: "json" }));
  const seenAuth: (string | undefined)[] = [];
  const srv = http.createServer(async (req, res) => {
    seenAuth.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
    let body = "";
    for await (const c of req) body += c;
    return handler(req as never, res as never, req.method === "POST" ? JSON.parse(body) : undefined);
  });
  const port = await new Promise<number>((r) =>
    srv.listen(0, "127.0.0.1", () => r((srv.address() as { port: number }).port)),
  );
  return { url: `http://127.0.0.1:${port}/mcp`, seenAuth, close: () => new Promise((r) => srv.close(() => r())) };
}

export interface RegistryScript {
  /** Search result names, in order. */
  order?: string[];
  /** Per server: whether the gate passes and why not. */
  gates?: Record<string, { pass: boolean; failed?: { rule: string; detail: string }[] }>;
  /** Per server: `remote` (default) or `package`. */
  kinds?: Record<string, "remote" | "package">;
  /** Per server: the connection class (default R1). */
  classes?: Record<string, string>;
  toolsHash?: string | null;
}

export interface SeenRequest {
  url: URL;
  headers: Headers;
  body: string;
}

/** A `fetch` for the registry client, and every request it received. */
export function fakeRegistry(
  mcpUrl: string,
  script: RegistryScript = {},
): { fetch: typeof fetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" });
    if (url.pathname === "/v1/search")
      return json({
        query: "",
        mode: "keyword",
        count: 0,
        results: (script.order ?? []).map((name) => ({ name })),
        next_actions: [],
      });
    const m = /^\/v1\/servers\/([^/]+)\/(gate|connection)$/.exec(url.pathname);
    if (!m) return json({ error: "not_found" }, 404);
    const name = decodeURIComponent(m[1]!);
    if (m[2] === "gate") {
      const g = script.gates?.[name] ?? { pass: true };
      return json({
        server: name,
        pass: g.pass,
        failed: g.failed ?? [],
        rules: {},
        quality: { score: 90, label: "good", flags: [], computed_at: null },
        trust: { score: 80, flags: [] },
        class: script.classes?.[name] ?? "R1",
        owner_verified: false,
        tools_hash: script.toolsHash === undefined ? "h1" : script.toolsHash,
        next_actions: [],
      });
    }
    const kind = script.kinds?.[name] ?? "remote";
    const entry =
      kind === "remote"
        ? { type: "http", url: mcpUrl, headers: { Authorization: "Bearer ${MAIL_TOKEN}" } }
        : { command: "npx", args: ["-y", "mail-mcp"] };
    return json({
      server: name,
      key: "mail",
      kind,
      class: script.classes?.[name] ?? "R1",
      autonomous: true,
      human_steps: [],
      target: "mcpServers",
      content_type: "application/json",
      connection: { mcpServers: { mail: entry } },
      secrets: [{ name: "MAIL_TOKEN", where: "header:Authorization" }],
      placeholders: "",
      next_actions: [],
    });
  }) as typeof fetch;
  return { fetch: f, seen };
}
