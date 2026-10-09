/**
 * R2 (OAuth) end to end: first run asks a human to open one URL; every later run connects
 * with the stored tokens and no human step.
 *   npx tsx examples/oauth-consent.ts <server-name> [token-file]
 * Uses the public registry; set REGISTRY_URL=http://localhost:8080 for a local stack.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectClient, createClient, FileTokenStore, hasTokens, loopbackConsent } from "../src/index.js";

const registry = createClient(process.env.REGISTRY_URL ? { baseUrl: process.env.REGISTRY_URL } : {});
const name = process.argv[2];
if (!name) {
  console.error("usage: oauth-consent.ts <server-name> [token-file]");
  process.exit(2);
}
const store = new FileTokenStore(process.argv[3] ?? ".mcp-tokens.json");
const conn = await registry.getConnection(name);
console.log(`${name}: class ${conn.class}, auth ${conn.auth_type ?? "?"}, tokens stored: ${await hasTokens(store, name)}`);

const consent = await loopbackConsent({ port: 8765 });
const mcp = new Client({ name: "protogrid-oauth-example", version: "0.1.0" });
const t0 = Date.now();
await connectClient(mcp, conn, process.env, { oauth: { store, consent, clientName: "protogrid example" } });
await consent.close?.();
const { tools } = await mcp.listTools();
console.log(`connected in ${Date.now() - t0} ms; ${tools.length} tools: ${tools.slice(0, 8).map((t) => t.name).join(", ")}`);
await mcp.close();
