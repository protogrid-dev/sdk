/** loadServers end to end: a scripted registry, and a real MCP server over HTTP on a local port. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeRegistry, startMailServer, TOKEN, type MailServer, type RegistryScript } from "./testing/fixture.js";
import { createClient } from "./client.js";
import { LoadReport, loadRules, loadServers, NoServerLoaded, prefixedToolName, type LoadOptions } from "./load.js";
import { toolHash, toolSetHash } from "./tools-hash.js";

let mail: MailServer;
beforeAll(async () => {
  mail = await startMailServer();
});
afterAll(() => mail.close());

const setup = (script: RegistryScript = {}, url?: string) => {
  const { fetch, seen } = fakeRegistry(url ?? mail.url, script);
  return { registry: createClient({ baseUrl: "http://reg", apiKey: "", fetch }), seen };
};
const load = async (opts: LoadOptions) => {
  const servers = await loadServers(opts);
  return { servers, close: () => Promise.all(servers.map((s) => s.close())) };
};

describe("tool hashes", () => {
  it("match the registry's", () => {
    // Computed with the registry's own toolHash and toolSetHash on 2026-11-23 (the same fixture as langchain-protogrid).
    const tools = [
      {
        name: "send_mail",
        title: "Send mail",
        description: 'Envía un correo · ✉️ "quoted"\nline',
        inputSchema: {
          type: "object",
          properties: { to: { type: "string" }, n: { type: "number", default: 1.0, maximum: 2.5 } },
          required: ["to"],
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      { name: "ping", inputSchema: { type: "object" } },
      {
        name: "nested",
        description: "",
        inputSchema: { b: [1, 2, { z: null, a: true }], a: "x" },
        outputSchema: { type: "object" },
      },
    ];
    expect(tools.map(toolHash)).toEqual([
      "05731c7493785f9617c2d89f8c78855a",
      "368ac32a74c771aeceef04b341a2e6a1",
      "b307a967b26050498731eacbf7544c20",
    ]);
    expect(toolSetHash(tools)).toBe("b23aae45d640ee5ab2730ce08a616530");
    expect(toolSetHash([...tools].reverse())).toBe("b23aae45d640ee5ab2730ce08a616530");
    expect(toolSetHash([])).toBeNull();
  });
});

describe("rules", () => {
  it("keep the defaults for what is left out, never allow L0, and refuse no class at all", () => {
    expect(loadRules()).toEqual({
      no_fail: ["tools.hidden_text", "tools.poisoning"],
      exclude_quality_flags: ["known-vulns"],
      class: ["R0", "R1"],
    });
    expect(loadRules({ min_quality: 70, class: ["R0", "R2", "L0"], no_fail: [], paid: false })).toEqual({
      exclude_quality_flags: ["known-vulns"],
      class: ["R0", "R2"],
      min_quality: 70,
      paid: false,
    });
    expect(() => loadRules({ class: ["L0"] })).toThrow(TypeError);
  });
  it("name tools in the characters every model accepts", () => {
    expect(prefixedToolName("mail.v2", "send mail")).toBe("mail_v2_send_mail");
    expect(prefixedToolName("k", "x".repeat(80))).toHaveLength(64);
  });
});

describe("loadServers", () => {
  it("loads a passing server with its secret, calls it, and never sends the secret to the registry", async () => {
    const { registry, seen } = setup();
    const report = new LoadReport();
    mail.seenAuth.length = 0;
    const { servers, close } = await load({
      servers: ["io.github.acme/mail"],
      secrets: { MAIL_TOKEN: TOKEN },
      registry,
      report,
    });
    try {
      expect(servers.map((s) => [s.server, s.key, s.toolsHash])).toEqual([["io.github.acme/mail", "mail", "h1"]]);
      expect(servers[0]!.tools.map((t) => t.name).sort()).toEqual(["ping", "send"]);
      const out = await servers[0]!.callTool("send", { to: "a@b.c" });
      expect(out.content).toEqual([{ type: "text", text: "sent to a@b.c" }]);
      expect(mail.seenAuth).toContain(`Bearer ${TOKEN}`);
      for (const r of seen) expect(r.url.href + r.body + [...r.headers.values()].join()).not.toContain(TOKEN);
      expect(report.loaded).toEqual({ "io.github.acme/mail": "h1" });
      const gate = seen.find((r) => r.url.pathname.endsWith("/gate"))!.url.searchParams;
      expect(Object.fromEntries(gate)).toEqual({
        no_fail: "tools.hidden_text,tools.poisoning",
        exclude_quality_flags: "known-vulns",
        class: "R0,R1",
      });
    } finally {
      await close();
    }
  });

  it("passes over what fails, and says why", async () => {
    const { registry } = setup({
      gates: {
        "io.github.acme/bad": { pass: false, failed: [{ rule: "no_fail", detail: "tools.hidden_text fails" }] },
      },
      kinds: { "io.github.acme/local": "package" },
      classes: { "io.github.acme/oauth": "R2" },
    });
    const err = await loadServers({
      servers: ["io.github.acme/bad", "io.github.acme/local", "io.github.acme/nokey", "io.github.acme/oauth"],
      registry,
      rules: { class: ["R0", "R1", "R2"] },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoServerLoaded);
    expect((err as NoServerLoaded).report.skipped).toEqual([
      { server: "io.github.acme/bad", reason: "tools.hidden_text fails" },
      { server: "io.github.acme/local", reason: "not a remote server (local packages are never loaded)" },
      { server: "io.github.acme/nokey", reason: "needs MAIL_TOKEN, not in secrets" },
      { server: "io.github.acme/oauth", reason: "needs a sign-in (pass oauth to allow it)" },
    ]);
    expect((err as Error).message).toContain("io.github.acme/bad: tools.hidden_text fails");
  });

  it("tries search results in order, sends the rules to search, and stops at maxServers", async () => {
    const { registry, seen } = setup({
      gates: {
        "io.github.acme/first": { pass: false, failed: [{ rule: "min_quality", detail: "quality 50 is under 70" }] },
      },
      order: ["io.github.acme/first", "io.github.acme/second", "io.github.acme/third"],
    });
    const report = new LoadReport();
    const { close } = await load({
      query: "send mail",
      rules: { min_quality: 70, paid: false },
      secrets: { MAIL_TOKEN: TOKEN },
      registry,
      report,
    });
    await close();
    expect(Object.keys(report.loaded)).toEqual(["io.github.acme/second"]);
    expect(seen.some((r) => r.url.pathname.includes("third"))).toBe(false);
    const search = Object.fromEntries(seen.find((r) => r.url.pathname === "/v1/search")!.url.searchParams);
    expect(search).toEqual({
      q: "send mail",
      limit: "10",
      class: "R0,R1",
      min_quality: "70",
      exclude_quality_flags: "known-vulns",
      paid: "false",
    });
    expect(seen.find((r) => r.url.pathname.endsWith("/gate"))!.url.searchParams.get("paid")).toBe("false");
  });

  it("honours pins and strictTools", async () => {
    const probe = await load({
      servers: ["io.github.acme/mail"],
      secrets: { MAIL_TOKEN: TOKEN },
      registry: setup().registry,
    });
    const good = toolSetHash(probe.servers[0]!.tools)!;
    await probe.close();
    const pinned = await load({
      servers: ["io.github.acme/mail"],
      secrets: { MAIL_TOKEN: TOKEN },
      registry: setup({ toolsHash: good }).registry,
      pins: { "io.github.acme/mail": good },
      strictTools: true,
    });
    expect(pinned.servers).toHaveLength(1);
    await pinned.close();
    await expect(
      loadServers({
        servers: ["io.github.acme/mail"],
        secrets: { MAIL_TOKEN: TOKEN },
        registry: setup({ toolsHash: good }).registry,
        pins: { "io.github.acme/mail": "old" },
      }),
    ).rejects.toThrow(/tools changed since pinned \(old is now /);
    await expect(
      loadServers({
        servers: ["io.github.acme/mail"],
        secrets: { MAIL_TOKEN: TOKEN },
        registry: setup({ toolsHash: "what-protogrid-saw-before" }).registry,
        strictTools: true,
      }),
    ).rejects.toThrow(/lists tools other than the ones protogrid checked/);
  });

  it("passes over a server that cannot be reached, or refuses the secret", async () => {
    await expect(
      loadServers({
        servers: ["io.github.acme/mail"],
        secrets: { MAIL_TOKEN: TOKEN },
        registry: setup({}, "http://127.0.0.1:9/mcp").registry,
      }),
    ).rejects.toThrow(/could not connect/);
    await expect(
      loadServers({ servers: ["io.github.acme/mail"], secrets: { MAIL_TOKEN: "wrong" }, registry: setup().registry }),
    ).rejects.toThrow(/could not connect/);
  });

  it("needs a query or servers, not both", async () => {
    await expect(loadServers({})).rejects.toThrow(TypeError);
    await expect(loadServers({ query: "x", servers: [] })).rejects.toThrow(TypeError);
  });
});
