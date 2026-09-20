import { describe, expect, it } from "vitest";
import { createClient, ProtogridError } from "./client.js";
import { findConnectable, resolveEntry, secretsSatisfied } from "./connect.js";
import { MissingSecretsError, placeholdersIn, substituteSecrets } from "./secrets.js";
import type { McpServersConnection, SearchResponse } from "./types.js";

const conn = (over: Partial<McpServersConnection> = {}): McpServersConnection => ({
  server: "io.github.acme/acme-mcp",
  key: "acme-mcp",
  kind: "remote",
  class: "R1",
  autonomous: true,
  human_steps: [],
  target: "mcpServers",
  content_type: "application/json",
  connection: { mcpServers: { "acme-mcp": { type: "http", url: "https://mcp.acme.dev/mcp", headers: { Authorization: "Bearer ${ACME_TOKEN}" } } } },
  secrets: [{ name: "ACME_TOKEN", where: "header:Authorization" }],
  placeholders: "",
  next_actions: [],
  ...over,
});

describe("secrets", () => {
  it("finds and substitutes placeholders deeply", () => {
    const c = conn();
    expect(placeholdersIn(c.connection)).toEqual(["ACME_TOKEN"]);
    const out = substituteSecrets(c.connection, { ACME_TOKEN: "sk-1" });
    expect((out.mcpServers["acme-mcp"] as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer sk-1");
    // input untouched
    expect((c.connection.mcpServers["acme-mcp"] as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer ${ACME_TOKEN}");
  });
  it("throws with the missing names, or leaves them with partial", () => {
    expect(() => substituteSecrets(conn().connection, {})).toThrow(MissingSecretsError);
    try {
      substituteSecrets(conn().connection, {});
    } catch (e) {
      expect((e as MissingSecretsError).missing).toEqual(["ACME_TOKEN"]);
    }
    expect(placeholdersIn(substituteSecrets(conn().connection, {}, { partial: true }))).toEqual(["ACME_TOKEN"]);
  });
  it("resolveEntry and secretsSatisfied", () => {
    expect(secretsSatisfied(conn(), {})).toBe(false);
    expect(secretsSatisfied(conn(), { ACME_TOKEN: "x" })).toBe(true);
    expect(resolveEntry(conn(), { ACME_TOKEN: "x" }).entry).toEqual({ type: "http", url: "https://mcp.acme.dev/mcp", headers: { Authorization: "Bearer x" } });
  });
});

describe("client", () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u + "|" + ((init?.headers as Record<string, string>)?.authorization ?? ""));
    if (u.includes("/v1/search")) {
      const body: SearchResponse = {
        query: "x",
        mode: "keyword",
        count: 2,
        results: [
          { name: "a/oauth", title: null, description: "", connection_class: "R2", autonomous: false, human_steps: ["oauth_consent_once"], categories: [], trust_score: 50, trust_flags: [], tool_count: 1, score: 1, matched_tools: [] },
          { name: "io.github.acme/acme-mcp", title: null, description: "", connection_class: "R1", autonomous: true, human_steps: [], categories: [], trust_score: 90, trust_flags: [], tool_count: 3, score: 0.9, matched_tools: [] },
        ],
        next_actions: [],
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (u.includes("/connection")) return new Response(JSON.stringify(conn()), { status: 200 });
    if (u.includes("nothing")) return new Response(JSON.stringify({ error: "not_found", server: "nothing" }), { status: 404 });
    if (u.includes("limited")) return new Response("", { status: 429, headers: { "retry-after": "7" } });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const client = createClient({ baseUrl: "http://reg/", apiKey: "k", fetch: fakeFetch });

  it("builds urls and sends the key", async () => {
    await client.search({ q: "send email", class: ["R0", "R1"], min_trust: 80, exclude_flags: ["multi-version-spam", "duplicate-repo"] });
    expect(calls.at(-1)).toBe("http://reg/v1/search?q=send+email&class=R0%2CR1&min_trust=80&exclude_flags=multi-version-spam%2Cduplicate-repo|Bearer k");
    await client.listTools("io.github.acme/acme-mcp", { cursor: "z", limit: 5 });
    expect(calls.at(-1)).toBe("http://reg/v1/servers/io.github.acme%2Facme-mcp/tools?limit=5&cursor=z|Bearer k");
  });
  it("maps errors", async () => {
    await expect(client.getServer("nothing")).rejects.toMatchObject({ status: 404, code: "not_found" });
    const e = await client.getServer("limited").catch((x: ProtogridError) => x);
    expect(e).toBeInstanceOf(ProtogridError);
    expect((e as ProtogridError).retryAfterMs).toBe(7000);
  });
  it("findConnectable skips non-autonomous results and honors secrets", async () => {
    expect(await findConnectable(client, { q: "x" })).toBeNull();
    const found = await findConnectable(client, { q: "x" }, { secrets: { ACME_TOKEN: "s" } });
    expect(found?.result.name).toBe("io.github.acme/acme-mcp");
    expect(found?.connection.kind).toBe("remote");
  });
});
