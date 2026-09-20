/**
 * End-to-end OAuth flow against an in-process authorization server and a protected MCP
 * server: consent once, then reconnect with stored tokens and no human step.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { connectClient, findConnectable } from "./connect.js";
import { createClient } from "./client.js";
import { hasTokens, loopbackConsent, MemoryTokenStore } from "./oauth.js";
import { toClaudeAgentSdk, toRawTransport } from "./formatters.js";
import type { McpServersConnection } from "./types.js";

const listen = (srv: http.Server) => new Promise<number>((res) => srv.listen(0, "127.0.0.1", () => res((srv.address() as { port: number }).port)));
const readBody = (req: http.IncomingMessage) => new Promise<string>((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });

let as: http.Server, rs: http.Server, asUrl: string, rsUrl: string;
const asLog: string[] = [];
const ACCESS = "tok-" + Math.random().toString(36).slice(2);

beforeAll(async () => {
  // --- fake authorization server: metadata, dynamic registration, authorize (auto-approve), token ---
  as = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", asUrl);
    asLog.push(`${req.method} ${url.pathname}`);
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, { issuer: asUrl, authorization_endpoint: `${asUrl}/authorize`, token_endpoint: `${asUrl}/token`, registration_endpoint: `${asUrl}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    }
    if (url.pathname === "/register") {
      const meta = JSON.parse(await readBody(req));
      return json(201, { client_id: "client-123", ...meta });
    }
    if (url.pathname === "/authorize") {
      // A human would see a consent screen; here we approve and redirect straight away.
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("client_id")).toBe("client-123");
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", "code-xyz");
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: redirect.toString() }).end();
      return;
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("grant_type") === "authorization_code") {
        expect(form.get("code")).toBe("code-xyz");
        expect(form.get("code_verifier")).toBeTruthy();
        return json(200, { access_token: ACCESS, token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1" });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    res.writeHead(404).end();
  });
  const asPort = await listen(as);
  asUrl = `http://127.0.0.1:${asPort}`;

  // --- fake protected MCP server: 401 + PRM until the bearer token is presented ---
  const mcp = new McpServer({ name: "protected", version: "0" });
  mcp.registerTool("whoami", { description: "returns the caller", inputSchema: { name: z.string().optional() } }, async (a) => ({ content: [{ type: "text", text: `hello ${a.name ?? "agent"}` }] }));
  rs = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", rsUrl);
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ resource: `${rsUrl}/mcp`, authorization_servers: [asUrl] }));
    }
    if (url.pathname === "/mcp") {
      if (req.headers.authorization !== `Bearer ${ACCESS}`) {
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${rsUrl}/.well-known/oauth-protected-resource"` });
        return res.end();
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const body = JSON.parse(await readBody(req));
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true } as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
      await mcp.connect(transport as never);
      res.on("close", () => void transport.close());
      return transport.handleRequest(req, res, body);
    }
    res.writeHead(404).end();
  });
  const rsPort = await listen(rs);
  rsUrl = `http://127.0.0.1:${rsPort}`;
});

afterAll(() => {
  as.close();
  rs.close();
});

const connection = (): McpServersConnection => ({
  server: "test.example/protected",
  key: "protected",
  kind: "remote",
  class: "R2",
  autonomous: false,
  human_steps: ["oauth_consent_once"],
  target: "mcpServers",
  content_type: "application/json",
  connection: { mcpServers: { protected: { type: "http", url: `${rsUrl}/mcp` } } },
  secrets: [],
  auth_type: "oauth2",
  placeholders: "",
  next_actions: [],
});

describe("oauth consent flow", () => {
  const store = new MemoryTokenStore();

  it("consents once, then connects and calls a tool", async () => {
    let shown: URL | null = null;
    const consent = await loopbackConsent({
      onAuthorizationUrl: async (url) => {
        shown = url;
        // Simulate the human: follow the authorization URL, which 302s to the loopback redirect.
        await fetch(url, { redirect: "follow" });
      },
    });
    const client = new Client({ name: "t", version: "0" });
    const transport = await connectClient(client, connection(), {}, { oauth: { store, consent, clientName: "test" } });
    expect(shown).not.toBeNull();
    expect(shown!.pathname).toBe("/authorize");
    expect(await hasTokens(store, "test.example/protected")).toBe(true);
    const out = await client.callTool({ name: "whoami", arguments: { name: "bot" } });
    expect((out.content as { text: string }[])[0]!.text).toBe("hello bot");
    await transport.close();
    await consent.close?.();
    expect(asLog).toContain("POST /register");
    expect(asLog.filter((l) => l === "POST /token")).toHaveLength(1);
  });

  it("reconnects with stored tokens and no human step", async () => {
    let asked = 0;
    const consent = await loopbackConsent({ onAuthorizationUrl: () => { asked++; } });
    const client = new Client({ name: "t2", version: "0" });
    const transport = await connectClient(client, connection(), {}, { oauth: { store, consent } });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["whoami"]);
    expect(asked).toBe(0);
    await transport.close();
    await consent.close?.();
  });

  it("findConnectable treats R2 as connectable only with stored tokens", async () => {
    const calls: string[] = [];
    const fake = (async (u: string | URL) => {
      calls.push(String(u));
      if (String(u).includes("/v1/search")) {
        return new Response(JSON.stringify({ query: "x", mode: "keyword", count: 1, results: [{ name: "test.example/protected", title: null, description: "", connection_class: "R2", autonomous: false, human_steps: ["oauth_consent_once"], categories: [], trust_score: 80, trust_flags: [], tool_count: 1, score: 1, matched_tools: [] }], next_actions: [] }));
      }
      return new Response(JSON.stringify(connection()));
    }) as unknown as typeof fetch;
    const registry = createClient({ baseUrl: "http://reg", fetch: fake });
    expect(await findConnectable(registry, { q: "x" })).toBeNull();
    expect(calls[0]).toContain("class=R0%2CR1");
    const found = await findConnectable(registry, { q: "x" }, { tokenStore: store });
    expect(found?.result.name).toBe("test.example/protected");
    expect(await findConnectable(registry, { q: "x" }, { tokenStore: new MemoryTokenStore() })).toBeNull();
  });
});

describe("formatters", () => {
  it("produce Claude Agent SDK and raw transport shapes", () => {
    const c = connection();
    expect(toClaudeAgentSdk(c)).toEqual({ protected: { type: "http", url: `${rsUrl}/mcp` } });
    expect(toRawTransport(c)).toMatchObject({ kind: "streamable-http", requestInit: { headers: {} } });
    const pkg: McpServersConnection = { ...c, kind: "package", connection: { mcpServers: { protected: { command: "npx", args: ["-y", "x"], env: { T: "${T}" } } } } };
    expect(toClaudeAgentSdk(pkg, { T: "v" })).toEqual({ protected: { type: "stdio", command: "npx", args: ["-y", "x"], env: { T: "v" } } });
  });
});
