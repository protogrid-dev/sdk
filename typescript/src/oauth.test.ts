/**
 * End-to-end OAuth flow against an in-process authorization server and a protected MCP
 * server (MCP SDK v2, serving both protocol eras): consent once, then reconnect with stored
 * tokens and no human step; redirects with a foreign state, a foreign issuer or an error are refused.
 */
import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, IssuerMismatchError } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { connectClient, findConnectable } from "./connect.js";
import { createClient } from "./client.js";
import { hasTokens, loopbackConsent, manualConsent, MemoryTokenStore } from "./oauth.js";
import { toClaudeAgentSdk, toRawTransport } from "./formatters.js";
import type { McpServersConnection } from "./types.js";

const listen = (srv: http.Server) => new Promise<number>((res) => srv.listen(0, "127.0.0.1", () => res((srv.address() as { port: number }).port)));
const readBody = (req: http.IncomingMessage) => new Promise<string>((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });

let as: http.Server, rs: http.Server, asUrl: string, rsUrl: string;
const asLog: string[] = [];
const ACCESS = "tok-" + Math.random().toString(36).slice(2);
/** How the fake authorization server answers the next /authorize: like a real one, or like an attacker. */
let redirectMode: "ok" | "foreign-state" | "foreign-iss" | "error" = "ok";

beforeAll(async () => {
  // --- fake authorization server: metadata (with RFC 9207 iss support), registration, authorize (auto-approve), token ---
  as = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", asUrl);
    asLog.push(`${req.method} ${url.pathname}`);
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, { issuer: asUrl, authorization_endpoint: `${asUrl}/authorize`, token_endpoint: `${asUrl}/token`, registration_endpoint: `${asUrl}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true });
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
      const state = url.searchParams.get("state") ?? "";
      if (redirectMode === "error") {
        redirect.searchParams.set("error", "access_denied");
        redirect.searchParams.set("error_description", "<script>alert(1)</script> call +1 555");
      } else {
        redirect.searchParams.set("code", "code-xyz");
      }
      redirect.searchParams.set("state", redirectMode === "foreign-state" ? "attacker-state" : state);
      redirect.searchParams.set("iss", redirectMode === "foreign-iss" ? "https://attacker.example" : asUrl);
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

  // --- fake protected MCP server: 401 + PRM until the bearer token is presented; 2026-07-28 and 2025 eras ---
  const factory = () => {
    const mcp = new McpServer({ name: "protected", version: "0" });
    mcp.registerTool("whoami", { description: "returns the caller", inputSchema: z.object({ name: z.string().optional() }) }, async (a) => ({ content: [{ type: "text", text: `hello ${a.name ?? "agent"}` }] }));
    return mcp;
  };
  const handler = toNodeHandler(createMcpHandler(factory, { legacy: "stateless", responseMode: "json" }));
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
      const body = req.method === "POST" ? JSON.parse(await readBody(req)) : undefined;
      return handler(req as never, res as never, body);
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

beforeEach(() => {
  redirectMode = "ok";
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

/** Consent that simulates the human: follow the authorization URL, which 302s to the loopback redirect. */
const autoConsent = (onUrl?: (url: URL) => void) => loopbackConsent({ onAuthorizationUrl: async (url) => { onUrl?.(url); await fetch(url, { redirect: "follow" }); } });

describe("oauth consent flow", () => {
  const store = new MemoryTokenStore();

  it("consents once, then connects on the 2026-07-28 protocol and calls a tool", async () => {
    let shown: URL | null = null;
    const consent = await autoConsent((url) => (shown = url));
    const client = new Client({ name: "t", version: "0" }, { versionNegotiation: { mode: "auto" } });
    const transport = await connectClient(client, connection(), {}, { oauth: { store, consent, clientName: "test" } });
    expect(shown).not.toBeNull();
    expect(shown!.pathname).toBe("/authorize");
    expect(client.getProtocolEra()).toBe("modern");
    expect(await hasTokens(store, "test.example/protected")).toBe(true);
    expect(await store.get("test.example/protected:discovery")).toBeTruthy();
    expect(await store.get("test.example/protected:state")).toBeUndefined(); // used once
    const out = await client.callTool({ name: "whoami", arguments: { name: "bot" } });
    expect((out.content as { text: string }[])[0]!.text).toBe("hello bot");
    await transport.close();
    await consent.close?.();
    expect(asLog).toContain("POST /register");
    expect(asLog.filter((l) => l === "POST /token")).toHaveLength(1);
  });

  it("reconnects with stored tokens and no human step, on the 2025 protocol too", async () => {
    let asked = 0;
    const consent = await loopbackConsent({ onAuthorizationUrl: () => { asked++; } });
    const client = new Client({ name: "t2", version: "0" });
    const transport = await connectClient(client, connection(), {}, { oauth: { store, consent } });
    expect(client.getProtocolEra()).toBe("legacy");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["whoami"]);
    expect(asked).toBe(0);
    await transport.close();
    await consent.close?.();
  });

  const refused = async (mode: typeof redirectMode) => {
    redirectMode = mode;
    const fresh = new MemoryTokenStore();
    const tokenPosts = asLog.filter((l) => l === "POST /token").length;
    const consent = await autoConsent();
    const client = new Client({ name: "t3", version: "0" }, { versionNegotiation: { mode: "auto" } });
    const err = await connectClient(client, connection(), {}, { oauth: { store: fresh, consent } }).then(() => null, (e: unknown) => e);
    await consent.close?.();
    expect(asLog.filter((l) => l === "POST /token").length).toBe(tokenPosts); // no code was exchanged
    expect(await hasTokens(fresh, "test.example/protected")).toBe(false);
    return err as Error;
  };

  it("refuses a redirect whose state this flow did not send", async () => {
    expect((await refused("foreign-state")).message).toMatch(/state does not match/);
  });

  it("refuses a redirect from another issuer (RFC 9207)", async () => {
    expect(await refused("foreign-iss")).toBeInstanceOf(IssuerMismatchError);
  });

  it("reports a denied consent by its error code only", async () => {
    const err = await refused("error");
    expect(err.message).toBe("authorization was not granted (access_denied)");
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

describe("manualConsent", () => {
  it("reads code, state and iss from the pasted redirect URL", async () => {
    const consent = manualConsent({ redirectUrl: "http://127.0.0.1:8765/callback", onAuthorizationUrl: () => {}, waitForRedirect: async () => " http://127.0.0.1:8765/callback?code=c1&state=s1&iss=https%3A%2F%2Fas.example \n" });
    const params = await consent.waitForCallback();
    expect([params.get("code"), params.get("state"), params.get("iss")]).toEqual(["c1", "s1", "https://as.example"]);
  });

  it("refuses something that is not a URL", async () => {
    const consent = manualConsent({ redirectUrl: "http://127.0.0.1:8765/callback", onAuthorizationUrl: () => {}, waitForRedirect: async () => "c1" });
    await expect(consent.waitForCallback()).rejects.toThrow(/full URL/);
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
