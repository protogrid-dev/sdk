# protogrid SDKs

Clients for [protogrid](https://protogrid.dev), the MCP registry for agents: search servers by intent, get a ready connection block, connect without a human in the loop.

| package | install | docs |
|---|---|---|
| TypeScript `@protogrid/sdk` ([typescript/](typescript/)) | `pnpm add @protogrid/sdk @modelcontextprotocol/sdk` | [docs.protogrid.dev/sdk/typescript](https://docs.protogrid.dev/sdk/typescript/) |
| Python `protogrid-sdk` ([python/](python/)) | `uv add "protogrid-sdk[mcp]"` | [docs.protogrid.dev/sdk/python](https://docs.protogrid.dev/sdk/python/) |

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
