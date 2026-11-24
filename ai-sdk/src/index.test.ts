/** @protogrid/ai-sdk end to end: a scripted registry, a real MCP server over HTTP, and generateText with a scripted model. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createClient, NoServerLoaded } from "@protogrid/sdk";
import {
  fakeRegistry,
  startMailServer,
  TOKEN,
  type MailServer,
  type RegistryScript,
} from "../../typescript/src/testing/fixture.js";
import { gateTool, loadTools, searchTool, toModelOutput } from "./index.js";

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

describe("loadTools", () => {
  it("gives generateText the tools of a passing server, named <key>_<tool>, and the model reads the result", async () => {
    const { registry: reg, seen } = registry();
    await using loaded = await loadTools({
      servers: ["io.github.acme/mail"],
      secrets: { MAIL_TOKEN: TOKEN },
      registry: reg,
    });
    expect(Object.keys(loaded.tools).sort()).toEqual(["mail_ping", "mail_send"]);
    expect(loaded.origins["mail_send"]).toEqual({ server: "io.github.acme/mail", tool: "send", toolsHash: "h1" });
    const model = callThenAnswer("mail_send", { to: "ops@acme.dev" });
    const out = await generateText({ model, tools: loaded.tools, prompt: "mail ops", stopWhen: stepCountIs(2) });
    expect(out.text).toBe("done");
    expect(out.steps[0]!.toolResults[0]!.output).toMatchObject({
      content: [{ type: "text", text: "sent to ops@acme.dev" }],
    });
    // The second model call saw the tool result as text content.
    const prompt = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    expect(prompt).toContain("sent to ops@acme.dev");
    // The model got the server's own schema.
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

describe("toModelOutput", () => {
  it("maps text, images and resources, and an error to error text", () => {
    expect(
      toModelOutput({
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "resource_link", uri: "file:///x", name: "x" },
        ],
      }),
    ).toEqual({
      type: "content",
      value: [
        { type: "text", text: "a" },
        { type: "file", data: { type: "data", data: "AAAA" }, mediaType: "image/png" },
        { type: "text", text: "[resource file:///x (x)]" },
      ],
    });
    expect(toModelOutput({ content: [{ type: "text", text: "no such user" }], isError: true })).toEqual({
      type: "error-text",
      value: "no such user",
    });
    expect(toModelOutput({ content: [], structuredContent: { n: 1 } })).toEqual({ type: "json", value: { n: 1 } });
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
    const s = await generateText({
      model: callThenAnswer("protogrid_search", { query: "send mail" }),
      tools,
      prompt: "find",
      stopWhen: stepCountIs(2),
    });
    expect((s.steps[0]!.toolResults[0]!.output as { name: string }[])[0]!.name).toBe("io.github.acme/mail");
    const g = await generateText({
      model: callThenAnswer("protogrid_gate", { server: "io.github.acme/mail", min_quality: 0 }),
      tools,
      prompt: "check",
      stopWhen: stepCountIs(2),
    });
    expect(g.steps[0]!.toolResults[0]!.output).toMatchObject({ pass: false, failed: ["quality 90 is under 95"] });
    expect(seen.find((r) => r.url.pathname.endsWith("/gate"))!.url.searchParams.get("min_quality")).toBe("95");
  });
});
