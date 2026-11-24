/** @protogrid/langchain end to end: a scripted registry, a real MCP server over HTTP, and createAgent with a scripted model. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { createAgent } from "langchain";
import { createClient, NoServerLoaded } from "@protogrid/sdk";
import {
  fakeRegistry,
  startMailServer,
  TOKEN,
  type MailServer,
  type RegistryScript,
} from "../../typescript/src/testing/fixture.js";
import { gateTool, loadTools, searchTool, toolContent } from "./index.js";

let mail: MailServer;
beforeAll(async () => {
  mail = await startMailServer();
});
afterAll(() => mail.close());

const registry = (script: RegistryScript = {}) => {
  const { fetch, seen } = fakeRegistry(mail.url, script);
  return { registry: createClient({ baseUrl: "http://reg", apiKey: "", fetch }), seen };
};
const callThenAnswer = (name: string, args: Record<string, unknown>) =>
  fakeModel()
    .respondWithTools([{ name, args, id: "c1" }])
    .respond(new AIMessage("done"));
const toolMessages = (out: { messages: unknown[] }) =>
  out.messages.filter((m): m is ToolMessage => ToolMessage.isInstance(m as ToolMessage));

describe("loadTools", () => {
  it("gives createAgent the tools of a passing server, named <key>_<tool>, and the model reads the result", async () => {
    const { registry: reg, seen } = registry();
    await using loaded = await loadTools({
      servers: ["io.github.acme/mail"],
      secrets: { MAIL_TOKEN: TOKEN },
      registry: reg,
    });
    expect(loaded.tools.map((t) => t.name).sort()).toEqual(["mail_ping", "mail_send"]);
    expect(loaded.origins["mail_send"]).toEqual({ server: "io.github.acme/mail", tool: "send", toolsHash: "h1" });
    const send = loaded.tools.find((t) => t.name === "mail_send")!;
    expect((send.schema as { required?: string[] }).required).toEqual(["to"]);
    const model = callThenAnswer("mail_send", { to: "ops@acme.dev" });
    const out = await createAgent({ model, tools: loaded.tools }).invoke({
      messages: [{ role: "user", content: "mail ops" }],
    });
    const [msg] = toolMessages(out);
    expect(msg!.content).toBe("sent to ops@acme.dev");
    expect(msg!.status).not.toBe("error");
    expect(msg!.artifact).toMatchObject({ content: [{ type: "text", text: "sent to ops@acme.dev" }] });
    expect((out.messages.at(-1) as AIMessage).content).toBe("done");
    // The second model call saw the tool result.
    expect(JSON.stringify(model.calls[1]!.messages)).toContain("sent to ops@acme.dev");
    for (const r of seen) expect(r.url.href + [...r.headers.values()].join()).not.toContain(TOKEN);
  });

  it("an argument that breaks the server's schema reaches the model as a failed call, and never reaches the server", async () => {
    const { registry: reg } = registry();
    await using loaded = await loadTools({
      servers: ["io.github.acme/mail"],
      secrets: { MAIL_TOKEN: TOKEN },
      registry: reg,
    });
    const before = mail.seenAuth.length;
    const out = await createAgent({ model: callThenAnswer("mail_send", { to: 7 }), tools: loaded.tools }).invoke({
      messages: [{ role: "user", content: "mail ops" }],
    });
    const [msg] = toolMessages(out);
    expect(msg!.status).toBe("error");
    expect(msg!.content).toContain("did not match expected schema");
    expect(mail.seenAuth.length).toBe(before);
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

describe("toolContent", () => {
  it("is the text of a text result, content blocks otherwise, the MCP result as the artifact, and throws on an error", () => {
    const text = {
      content: [
        { type: "text" as const, text: "a" },
        { type: "text" as const, text: "b" },
      ],
    };
    expect(toolContent(text)).toEqual(["a\nb", text]);
    const mixed = {
      content: [
        { type: "text" as const, text: "a" },
        { type: "image" as const, data: "AAAA", mimeType: "image/png" },
        { type: "resource_link" as const, uri: "file:///x", name: "x" },
      ],
    };
    expect(toolContent(mixed)[0]).toEqual([
      { type: "text", text: "a" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "text", text: "[resource file:///x (x)]" },
    ]);
    expect(toolContent({ content: [], structuredContent: { n: 1 } })[0]).toBe('{"n":1}');
    expect(() => toolContent({ content: [{ type: "text", text: "no such user" }], isError: true })).toThrow(
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
    const tools = [searchTool({ registry: reg }), gateTool({ registry: reg, rules: { min_quality: 95 } })];
    const s = await createAgent({ model: callThenAnswer("protogrid_search", { query: "send mail" }), tools }).invoke({
      messages: [{ role: "user", content: "find" }],
    });
    expect(JSON.parse(toolMessages(s)[0]!.content as string)[0].name).toBe("io.github.acme/mail");
    const g = await createAgent({
      model: callThenAnswer("protogrid_gate", { server: "io.github.acme/mail" }),
      tools,
    }).invoke({ messages: [{ role: "user", content: "check" }] });
    expect(JSON.parse(toolMessages(g)[0]!.content as string)).toMatchObject({
      pass: false,
      failed: ["quality 90 is under 95"],
    });
    expect(seen.find((r) => r.url.pathname.endsWith("/gate"))!.url.searchParams.get("min_quality")).toBe("95");
  });
});
