/**
 * End to end, no human: find a server for an intent, connect, call a tool you did not know existed.
 *   pnpm --filter @protogrid/sdk example "get the current weather" "Madrid"
 * Uses the public registry; set REGISTRY_URL=http://localhost:8080 for a local stack.
 * The second argument (optional) fills required string parameters of the chosen tool.
 * Secrets for R1 servers come from the environment: any `${NAME}` placeholder is read from process.env.NAME.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createClient, createTransport, findConnectable } from "../src/index.js";

const registry = createClient(process.env.REGISTRY_URL ? { baseUrl: process.env.REGISTRY_URL } : {});
const intent = process.argv[2] ?? "get the current weather for a city";
const stringValue = process.argv[3] ?? intent.replace(/^(get|find|search|list)\s+(the\s+)?/i, "");

const found = await findConnectable(registry, { q: intent, limit: 10 }, { secrets: process.env });
if (!found) {
  console.log(`nothing autonomous found for "${intent}"`);
  process.exit(1);
}
const { result, connection } = found;
console.log(`→ ${result.name} (${result.connection_class}, trust ${result.trust_score}); matched: ${result.matched_tools.map((t) => t.name).join(", ") || "server text"}`);

const transport = await createTransport(connection, process.env);
const mcp = new Client({ name: "protogrid-example", version: "0.1.0" });
await mcp.connect(transport);
const { tools } = await mcp.listTools();
console.log(`connected; ${tools.length} tools: ${tools.slice(0, 8).map((t) => t.name).join(", ")}${tools.length > 8 ? ", …" : ""}`);

// Prefer a matched tool; fall back to any tool that needs no required arguments.
const schemaOf = (t: (typeof tools)[number]) => t.inputSchema as { required?: string[]; properties?: Record<string, { type?: string; enum?: string[]; default?: unknown }> };
const argsFor = (t: (typeof tools)[number]) => {
  const s = schemaOf(t);
  const args: Record<string, unknown> = {};
  for (const r of s.required ?? []) {
    const p = s.properties?.[r];
    if (p?.default !== undefined) args[r] = p.default;
    else if (p?.enum?.length) args[r] = p.enum[0];
    else if (p?.type === "string") args[r] = stringValue;
    else if (p?.type === "number" || p?.type === "integer") args[r] = 1;
    else if (p?.type === "boolean") args[r] = true;
    else return null;
  }
  return args;
};
const candidates = [...result.matched_tools.map((m) => tools.find((t) => t.name === m.name)).filter((t): t is NonNullable<typeof t> => !!t), ...tools];
const pick = candidates.map((t) => ({ t, args: argsFor(t) })).find((c) => c.args !== null);
if (!pick) {
  console.log("no tool callable without more information; stopping here");
} else {
  console.log(`calling ${pick.t.name} with ${JSON.stringify(pick.args)}`);
  const out = await mcp.callTool({ name: pick.t.name, arguments: pick.args! });
  const text = (out.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(out.isError ? "tool error:" : "result:", text.slice(0, 600));
}
await mcp.close();
