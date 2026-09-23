# @protogrid/sdk

Client for the protogrid registry: find MCP servers by intent, get a machine-readable connection
block, and connect with no human in the loop wherever the server allows it.

```ts
import { createClient, createTransport, findConnectable } from "@protogrid/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const registry = createClient(); // public registry; { baseUrl: "http://localhost:8080" } for a local stack
const found = await findConnectable(registry, { q: "send an email" }, { secrets: process.env });
const mcp = new Client({ name: "my-agent", version: "1.0.0" });
await mcp.connect(await createTransport(found!.connection, process.env));
```

- `search`, `getServer`, `listTools`, `getConnection` mirror the REST API one to one.
- No key needed. A free key from https://protogrid.dev/account raises the limits (60 requests per minute,
  5,000 per day); the client reads `PROTOGRID_API_KEY`, or pass `createClient({ apiKey })`.
- Connection blocks carry `${NAME}` placeholders; `substituteSecrets` fills them from your own store.
  The registry never sees secret values.
- `connection_class`: **R0** remote, no auth · **R1** remote, static secret you hold · **R2** remote
  OAuth (one consent) · **L0** local package (runs on your machine, `allowLocal`) · `unknown`.
- `@modelcontextprotocol/sdk` is an optional peer dependency, needed for `createTransport`, `connectClient` and OAuth.
- R2 (OAuth) servers: `connectClient(client, conn, secrets, { oauth: { store, consent } })` runs the one-time consent
  (`loopbackConsent` or `manualConsent`) and keeps tokens in your `TokenStore`; later runs need no human.
- `toClaudeAgentSdk` / `toRawTransport` are pure formatters for the Claude Agent SDK and hand-built transports.
- Trust scores derive from observable signals only; no code audit is implied.

Example: `pnpm --filter @protogrid/sdk example "get the weather" "Madrid"` (add `REGISTRY_URL=http://localhost:8080` for a local stack).
