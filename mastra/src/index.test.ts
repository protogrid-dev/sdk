/** @protogrid/mastra end to end: a scripted registry, a real MCP server over HTTP, and a Mastra Agent with a scripted model. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@mastra/core/agent";
import { MockLanguageModelV4 } from "ai/test";
import { createClient, NoServerLoaded } from "@protogrid/sdk";
import {
  fakeRegistry,
  startMailServer,
  TOKEN,
  type MailServer,
  type RegistryScript,
} from "../../typescript/src/testing/fixture.js";
import { gateTool, loadTools, searchTool, toolOutput } from "./index.js";

let mail: MailServer;
beforeAll(async () => {
  mail = await startMailServer();
});
afterAll(() => mail.close());

const registry = (script: RegistryScript = {}) => {
  const { fetch, seen } = fakeRegistry(mail.url, script);
  return { registry: createClient({ baseUrl: "http://reg", apiKey: "", fetch }), seen };
};
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const callThenAnswer = (toolName: string, input: unknown) =>
  new MockLanguageModelV4({
    doGenerate: [
      {
        content: [{ type: "tool-call", toolCallId: "c1", toolName, input: JSON.stringify(input) }],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage,
        warnings: [],
      },
      {
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      },
    ],
  });
const agent = (model: MockLanguageModelV4, tools: Record<string, unknown>) =>
  new Agent({ id: "test", name: "test", instructions: "use the tools", model: model as never, tools: tools as never });
const results = (out: { toolResults: unknown[] }) =>
  out.toolResults.map(
    (r) => ((r as { payload?: { result?: unknown } }).payload ?? r) as { result?: unknown; toolName?: string },
  );

describe("loadTools", () => {
  it("gives an Agent the tools of a passing server, named <key>_<tool>, and the model reads the result", async () => {
    const { registry: reg, seen } = registry();
    await using loaded = await loadTools({
      servers: ["io.github.acme/mail"],
      secrets: { MAIL_TOKEN: TOKEN },
      registry: reg,
    });
    expect(Object.keys(loaded.tools).sort()).toEqual(["mail_ping", "mail_send"]);
    expect(loaded.origins["mail_send"]).toEqual({ server: "io.github.acme/mail", tool: "send", toolsHash: "h1" });
    const model = callThenAnswer("mail_send", { to: "ops@acme.dev" });
    const out = await agent(model, loaded.tools).generate("mail ops", { maxSteps: 2 });
    expect(out.text).toBe("done");
    expect(results(out)[0]!.result).toBe("sent to ops@acme.dev");
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("sent to ops@acme.dev");
    const sent = model.doGenerateCalls[0]!.tools!.find((t) => t.name === "mail_send") as {
      inputSchema: { required?: string[] };
    };
    expect(sent.inputSchema.required).toEqual(["to"]);
    for (const r of seen) expect(r.url.href + [...r.headers.values()].join()).not.toContain(TOKEN);
  });

  it("throws NoServerLoaded with the reason for each server passed over", async () => {
    const { registry: reg } = registry({
      gates: { "io.github.acme/bad": { pass: false, failed: [{ rule: "no_fail", detail: "tools.poisoning fails" }] } },
    });
    const err = await loadTools({ servers: ["io.github.acme/bad", "io.github.acme/nokey"], registry: reg }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NoServerLoaded);
    expect((err as NoServerLoaded).report.skipped.map((s) => s.reason)).toEqual([
      "tools.poisoning fails",
      "needs MAIL_TOKEN, not in secrets",
    ]);
  });
});

describe("toolOutput", () => {
  it("is the text of a text result, the result otherwise, and throws on an error", () => {
    expect(
      toolOutput({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
    const image = { content: [{ type: "image" as const, data: "AAAA", mimeType: "image/png" }] };
    expect(toolOutput(image)).toBe(image);
    expect(toolOutput({ content: [], structuredContent: { n: 1 } })).toEqual({ n: 1 });
    expect(() => toolOutput({ content: [{ type: "text", text: "no such user" }], isError: true })).toThrow(
      "no such user",
    );
  });
});

describe("searchTool and gateTool", () => {
  it("search the registry, and check a server with the rules given here, not the model's", async () => {
    const { registry: reg, seen } = registry({
      order: ["io.github.acme/mail"],
      gates: {
        "io.github.acme/mail": { pass: false, failed: [{ rule: "min_quality", detail: "quality 90 is under 95" }] },
      },
    });
    const tools = {
      protogrid_search: searchTool({ registry: reg }),
      protogrid_gate: gateTool({ registry: reg, rules: { min_quality: 95 } }),
    };
    const s = await agent(callThenAnswer("protogrid_search", { query: "send mail" }), tools).generate("find", {
      maxSteps: 2,
    });
    expect((results(s)[0]!.result as { name: string }[])[0]!.name).toBe("io.github.acme/mail");
    const g = await agent(callThenAnswer("protogrid_gate", { server: "io.github.acme/mail" }), tools).generate(
      "check",
      { maxSteps: 2 },
    );
    expect(results(g)[0]!.result).toMatchObject({ pass: false, failed: ["quality 90 is under 95"] });
    expect(seen.find((r) => r.url.pathname.endsWith("/gate"))!.url.searchParams.get("min_quality")).toBe("95");
  });
});
