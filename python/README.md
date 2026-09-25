# protogrid (Python)

Client for the protogrid registry: find MCP servers by intent, get a machine-readable connection
block, and connect with no human in the loop wherever the server allows it.

```python
import os
from protogrid import ProtogridClient, find_connectable, open_session

registry = ProtogridClient()  # public registry; ProtogridClient("http://localhost:8080") for a local stack
found = find_connectable(registry, "send an email", secrets=os.environ)
async with open_session(found.connection, os.environ) as session:   # mcp.ClientSession, initialized
    tools = await session.list_tools()
```

- `ProtogridClient` / `AsyncProtogridClient`: `search`, `get_server`, `list_tools`, `list_all_tools`, `get_connection`, and `check` / `get_check` for an on-demand check of any remote MCP server URL (quality and Claude and OpenAI directory readiness).
- No key needed. A free key from https://protogrid.dev/account raises the limits (60 requests per minute, 5,000 per day); the client reads `PROTOGRID_API_KEY`, or pass `ProtogridClient(api_key=...)`.
- Connection blocks carry `${NAME}` placeholders; `substitute_secrets` fills them from your own store. The registry never sees secret values.
- `connection_class`: **R0** remote, no auth · **R1** remote, static secret you hold · **R2** remote OAuth (one consent) · **L0** local package (`allow_local=True`) · `unknown`.
- R2: `open_session(conn, oauth=OAuthOptions(store, consent))` runs the one-time consent (`loopback_consent` or `manual_consent`) through the official SDK's OAuth provider and keeps tokens in your `TokenStore`; later runs need no human.
- PydanticAI: `to_pydantic_ai(conn, secrets)` returns an `MCPToolset`. `to_fastmcp_transport` and `to_mcp_servers` are pure formatters.
- Install: `pip install protogrid-sdk` (imported as `protogrid`). Extras: `protogrid-sdk[mcp]` for `open_session`, `protogrid-sdk[pydantic-ai]` for the toolset.

Examples: `examples/find_and_call.py` (search → connect → call a tool) and `examples/pydantic_ai_agent.py` (agent with a registry-found toolset, no LLM key needed).
