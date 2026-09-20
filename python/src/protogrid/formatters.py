"""Pure formatters connection → framework input (design rule: a formatter is a pure function,
no framework imported by the core). ``to_pydantic_ai`` imports PydanticAI lazily."""
from __future__ import annotations

from typing import Any

from .connect import Secrets, resolve_entry
from .types import ConnectionResponse


def to_mcp_servers(conn: ConnectionResponse, secrets: Secrets | None = None) -> dict[str, Any]:
    """Generic ``{"mcpServers": {key: entry}}`` block with secrets substituted."""
    key, entry = resolve_entry(conn, secrets)
    return {"mcpServers": {key: entry}}


def to_fastmcp_transport(conn: ConnectionResponse, secrets: Secrets | None = None) -> dict[str, Any]:
    """Constructor arguments for a FastMCP client transport (what PydanticAI's ``MCPToolset`` uses).

    Returns ``{"kind": "streamable-http" | "sse", "url", "headers"}`` or ``{"kind": "stdio", "command", "args", "env"}``.
    """
    _, entry = resolve_entry(conn, secrets)
    if "url" in entry:
        return {"kind": "sse" if entry.get("type") == "sse" else "streamable-http", "url": entry["url"], "headers": dict(entry.get("headers") or {})}
    return {"kind": "stdio", "command": entry["command"], "args": list(entry.get("args") or []), "env": dict(entry.get("env") or {})}


def to_pydantic_ai(conn: ConnectionResponse, secrets: Secrets | None = None, *, auth: Any = None, **toolset_kwargs: Any) -> Any:
    """A PydanticAI ``MCPToolset`` for the preferred remote or package (requires ``pydantic-ai``).

    ``auth`` may be an ``httpx.Auth`` (e.g. :func:`protogrid.oauth.oauth_provider`) for R2 servers.
    """
    from pydantic_ai.mcp import MCPToolset, SSETransport, StdioTransport, StreamableHttpTransport

    t = to_fastmcp_transport(conn, secrets)
    if t["kind"] == "stdio":
        transport: Any = StdioTransport(t["command"], t["args"], env=t["env"] or None)
    elif t["kind"] == "sse":
        transport = SSETransport(t["url"], headers=t["headers"] or None, auth=auth)
    else:
        transport = StreamableHttpTransport(t["url"], headers=t["headers"] or None, auth=auth)
    return MCPToolset(transport, id=conn["key"], **toolset_kwargs)
