# protogrid SDKs

Clients for [protogrid](https://protogrid.dev), the MCP registry for agents: search servers by intent, get a ready connection block, connect without a human in the loop.

| package                                                              | install                                                      | docs                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| TypeScript `@protogrid/sdk` ([typescript/](typescript/))             | `pnpm add @protogrid/sdk @modelcontextprotocol/client`       | [docs.protogrid.dev/sdk/typescript](https://docs.protogrid.dev/sdk/typescript/)         |
| Python `protogrid-sdk` ([python/](python/))                          | `uv add "protogrid-sdk[mcp]"`                                | [docs.protogrid.dev/sdk/python](https://docs.protogrid.dev/sdk/python/)                 |
| LangChain `langchain-protogrid` ([langchain/](langchain/))           | `pip install langchain-protogrid`                            | [docs.protogrid.dev/sdk/langchain](https://docs.protogrid.dev/sdk/langchain/)           |
| Vercel AI SDK `@protogrid/ai-sdk` ([ai-sdk/](ai-sdk/))               | `npm install @protogrid/ai-sdk ai`                           | [docs.protogrid.dev/sdk/ai-sdk](https://docs.protogrid.dev/sdk/ai-sdk/)                 |
| Mastra `@protogrid/mastra` ([mastra/](mastra/))                      | `npm install @protogrid/mastra @mastra/core`                 | [docs.protogrid.dev/sdk/mastra](https://docs.protogrid.dev/sdk/mastra/)                 |
| LangChain.js `@protogrid/langchain` ([langchain-js/](langchain-js/)) | `npm install @protogrid/langchain @langchain/core langchain` | [docs.protogrid.dev/sdk/langchain-js](https://docs.protogrid.dev/sdk/langchain-js/)     |
| CLI `protogridctl` ([cli/](cli/))                                    | `npx protogridctl add <server> --client cursor`              | [docs.protogrid.dev/guides/install-cli](https://docs.protogrid.dev/guides/install-cli/) |

Both talk to `https://api.protogrid.dev` by default and to any self-hosted registry by base URL.
The registry never sees secrets: connection blocks carry `${NAME}` placeholders that the SDKs fill from your own store.

- REST and MCP reference: [docs.protogrid.dev](https://docs.protogrid.dev). Every docs page has a Markdown twin and [`llms.txt`](https://docs.protogrid.dev/llms.txt).
- Issues and pull requests are welcome here. The registry platform itself is not open source.

## Develop

```bash
pnpm install && pnpm test          # TypeScript
cd python && uv sync && uv run pytest
```

MIT licensed.
