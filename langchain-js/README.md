# @protogrid/langchain

LangChain.js tools from the [protogrid](https://protogrid.dev) MCP registry: find MCP servers by what they do, check them against your rules, and give your agent the tools of the ones that pass.

```bash
npm install @protogrid/langchain @langchain/core langchain
```

```ts
import { createAgent } from "langchain";
import { loadTools } from "@protogrid/langchain";

await using mail = await loadTools({
  query: "send an email",
  rules: { min_quality: 70 }, // also refuses hidden text, tool poisoning and known vulnerabilities
  secrets: { MAIL_API_KEY: process.env.MAIL_API_KEY },
});
const agent = createAgent({ model: "anthropic:claude-sonnet-5", tools: mail.tools });
await agent.invoke({ messages: [{ role: "user", content: "Mail the report to ops" }] });
```

- `loadTools` tries the best search results (or the `servers` you name) in order. Each goes through protogrid's gate with your rules; one that passes is connected to directly, with no proxy, and its tools come back named `<server key>_<tool>`. `origins` says which server each tool comes from; `close()` (or `await using`) closes the connections.
- Secrets fill the `${NAME}` placeholders of the server's connection in your process; they are never sent to protogrid. A server needing a secret you did not give is passed over.
- Rules are yours, not the model's. A rule you leave out keeps its default, which refuses tools that hide text from people, tools holding instructions aimed at the model, and servers with a known vulnerability in their dependencies. `paid: false` also refuses servers that charge per call (x402). Local packages are never loaded.
- `pins: { "io.github.owner/server": "<tools_hash>" }` passes over a server whose checked tools changed since you reviewed them; `strictTools: true` also compares the tools the server lists right now with the ones protogrid checked.
- `searchTool()` and `gateTool({ rules })` let the agent look for servers and check one itself.

`@langchain/core` 1.5 or later, Node.js 20 or later. For Python, see [`langchain-protogrid`](https://pypi.org/project/langchain-protogrid/). Built on [`@protogrid/sdk`](https://www.npmjs.com/package/@protogrid/sdk) and the official MCP client. Full guide: [docs.protogrid.dev/sdk/langchain-js](https://docs.protogrid.dev/sdk/langchain-js/).

MIT licensed.
