# @protogrid/sdk

Client for the protogrid registry: find MCP servers by intent, get a machine-readable connection
block, and connect with no human in the loop wherever the server allows it.

```ts
import { createClient, createTransport, findConnectable } from "@protogrid/sdk";
import { Client } from "@modelcontextprotocol/client";

const registry = createClient(); // public registry; { baseUrl: "http://localhost:8080" } for a local stack
const found = await findConnectable(registry, { q: "send an email" }, { secrets: process.env });
const mcp = new Client({ name: "my-agent", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } }); // 2026-07-28 or 2025 servers
await mcp.connect(await createTransport(found!.connection, process.env));
```

- `search`, `getServer`, `listTools`, `getConnection`, `getQuality`, `getChanges`, `getDependencies` mirror the REST API one to one (search filters by connection class, trust, quality, quality flags such as `known-vulns`, and a verified owner); `check(url)` / `getCheck(id)` run an on-demand check of any remote MCP server URL (quality and Claude and OpenAI directory readiness; `{ fresh: true }` with a key skips the five-minute reuse).
- No key needed. A free key from https://protogrid.dev/account raises the limits (60 requests per minute,
  5,000 per day); the client reads `PROTOGRID_API_KEY`, or pass `createClient({ apiKey })`.
- Connection blocks carry `${NAME}` placeholders; `substituteSecrets` fills them from your own store.
  The registry never sees secret values.
- `connection_class`: **R0** remote, no auth · **R1** remote, static secret you hold · **R2** remote
  OAuth (one consent) · **L0** local package (runs on your machine, `allowLocal`) · `unknown`.
- `@modelcontextprotocol/client` 2.x (the official MCP client SDK v2) is an optional peer dependency, needed for
  `createTransport`, `connectClient` and OAuth. Still on the v1 package `@modelcontextprotocol/sdk`? Use `@protogrid/sdk`
  0.4.x until you move; a transport must come from the same package as your `Client`. Differences and the upgrade steps:
  https://docs.protogrid.dev/sdk/typescript/#versions-and-compatibility
- R2 (OAuth) servers: `connectClient(client, conn, secrets, { oauth: { store, consent } })` runs the one-time consent
  (`loopbackConsent` or `manualConsent`) and keeps tokens in your `TokenStore`; later runs need no human. The redirect's
  `state` and issuer are checked before any code is exchanged.
- `toClaudeAgentSdk` / `toRawTransport` are pure formatters for the Claude Agent SDK and hand-built transports.
- Trust scores derive from observable signals only; no code audit is implied.

Example: `pnpm --filter @protogrid/sdk example "get the weather" "Madrid"` (add `REGISTRY_URL=http://localhost:8080` for a local stack).
