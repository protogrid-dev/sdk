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

describe("api key default", () => {
  const seen: string[] = [];
  const fetchSpy = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push((init?.headers as Record<string, string>)?.authorization ?? "none");
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  it("reads PROTOGRID_API_KEY when no key is passed, and \"\" sends none", async () => {
    const before = process.env.PROTOGRID_API_KEY;
    process.env.PROTOGRID_API_KEY = "pgk_fromenv";
    try {
      await createClient({ baseUrl: "http://reg", fetch: fetchSpy }).getServer("a/b");
      await createClient({ baseUrl: "http://reg", fetch: fetchSpy, apiKey: "pgk_explicit" }).getServer("a/b");
      await createClient({ baseUrl: "http://reg", fetch: fetchSpy, apiKey: "" }).getServer("a/b");
    } finally {
      if (before === undefined) delete process.env.PROTOGRID_API_KEY;
      else process.env.PROTOGRID_API_KEY = before;
    }
    expect(seen).toEqual(["Bearer pgk_fromenv", "Bearer pgk_explicit", "none"]);
  });
});

describe("check (on-demand checks)", () => {
  const pending = (status: "queued" | "running") => ({ id: "abcdefghijklmnopqrstuv", status, url: "https://mcp.example.com/mcp", requested_at: "2026-09-25T00:00:00Z", finished_at: null, server: null, page: "https://protogrid.dev/check/abcdefghijklmnopqrstuv", disclaimer: "", next_actions: [] });

  it("posts the URL, then reads the check until it is done", async () => {
    const seen: string[] = [];
    let reads = 0;
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      seen.push(`${init?.method} ${u.replace("http://r.test", "")} ${init?.body ?? ""}`);
      if (init?.method === "POST") return new Response(JSON.stringify(pending("queued")), { status: 202 });
      reads++;
      const body = reads < 2 ? pending("running") : { ...pending("running"), status: "done", finished_at: "2026-09-25T00:00:05Z", result: { url: "https://mcp.example.com/mcp", readiness: [] } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const c = await createClient({ baseUrl: "http://r.test", fetch: f, apiKey: "" }).check("https://mcp.example.com/mcp");
    expect(c.status).toBe("done");
    expect(c.result?.url).toBe("https://mcp.example.com/mcp");
    expect(seen[0]).toMatch(/^POST \/v1\/check\?wait=25 \{"url":"https:\/\/mcp\.example\.com\/mcp"\}$/);
    expect(seen[1]).toMatch(/^GET \/v1\/check\/abcdefghijklmnopqrstuv\?wait=\d+ $/);
    expect(seen).toHaveLength(3);
  });

  it("returns at once with waitMs 0", async () => {
    const f = (async (url: string | URL | Request) => {
      expect(String(url)).toContain("/v1/check?wait=0");
      return new Response(JSON.stringify(pending("queued")), { status: 202 });
    }) as typeof fetch;
    expect((await createClient({ baseUrl: "http://r.test", fetch: f, apiKey: "" }).check("https://mcp.example.com/mcp", { waitMs: 0 })).status).toBe("queued");
  });

  it("surfaces refusals and quota with their codes", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ error: "check_quota_exceeded", scope: "you", message: "You ran 5 checks this hour." }), { status: 429, headers: { "retry-after": "120" } })) as typeof fetch;
    const err = await createClient({ baseUrl: "http://r.test", fetch: f, apiKey: "" }).check("https://mcp.example.com/mcp").catch((e) => e);
    expect(err).toBeInstanceOf(ProtogridError);
    expect(err.code).toBe("check_quota_exceeded");
    expect(err.retryAfterMs).toBe(120_000);
  });
});
