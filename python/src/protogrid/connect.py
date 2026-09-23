"""From a connection response to a live MCP session (official ``mcp`` package, optional)."""
from __future__ import annotations

import os
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from .client import AsyncProtogridClient, ProtogridClient, ProtogridError
from .oauth import ConsentHandler, TokenStore, has_tokens, oauth_provider
from .secrets import placeholders_in, substitute_secrets
from .types import ConnectionResponse, McpServersEntry, SearchResult

Secrets = Mapping[str, str | None]


def resolve_entry(conn: ConnectionResponse, secrets: Secrets | None = None, *, partial: bool = False) -> tuple[str, McpServersEntry]:
    """The single ``mcpServers`` entry of a connection response, with secrets substituted."""
    key = conn["key"]
    servers = conn["connection"]["mcpServers"]
    entry = servers.get(key) or next(iter(servers.values()), None)
    if entry is None:
        raise ValueError(f"connection for {conn['server']} has no mcpServers entry")
    return key, substitute_secrets(entry, secrets or {}, partial=partial)


def secrets_satisfied(conn: ConnectionResponse, secrets: Secrets | None = None) -> bool:
    """True when every placeholder the connection needs has a value in ``secrets``."""
    s = secrets or {}
    return all(s.get(n) is not None for n in placeholders_in(conn["connection"]))


@dataclass
class OAuthOptions:
    store: TokenStore
    consent: ConsentHandler
    client_name: str = "protogrid-sdk agent"
    scope: str | None = None
    client_metadata_url: str | None = None


@dataclass
class Connectable:
    result: SearchResult
    connection: ConnectionResponse


def _classes(class_: Sequence[str] | None, allow_local: bool, token_store: TokenStore | None) -> list[str]:
    if class_:
        return list(class_)
    return ["R0", "R1", *(["R2"] if token_store else []), *(["L0"] if allow_local else [])]


def _accept(result: SearchResult, conn: ConnectionResponse, secrets: Secrets | None, allow_local: bool, token_store: TokenStore | None) -> bool:
    if conn.get("kind") == "bundle":
        return False
    r2_ok = result["connection_class"] == "R2" and token_store is not None and has_tokens(token_store, result["name"])
    if not result["autonomous"] and not r2_ok and not (allow_local and result["connection_class"] == "L0"):
        return False
    return secrets_satisfied(conn, secrets)


def find_connectable(client: ProtogridClient, q: str, *, secrets: Secrets | None = None, allow_local: bool = False, token_store: TokenStore | None = None, limit: int = 10, class_: Sequence[str] | None = None, **search: Any) -> Connectable | None:
    """First search hit an agent can connect to now: R0, R1 with secrets present, R2 with stored tokens."""
    res = client.search(q, limit=limit, class_=_classes(class_, allow_local, token_store), **search)
    for result in res["results"]:
        if not result["autonomous"] and result["connection_class"] not in ("R2", "L0"):
            continue
        try:
            conn = client.get_connection(result["name"])
        except ProtogridError:
            continue
        if _accept(result, conn, secrets, allow_local, token_store):
            return Connectable(result, conn)
    return None


async def afind_connectable(client: AsyncProtogridClient, q: str, *, secrets: Secrets | None = None, allow_local: bool = False, token_store: TokenStore | None = None, limit: int = 10, class_: Sequence[str] | None = None, **search: Any) -> Connectable | None:
    res = await client.search(q, limit=limit, class_=_classes(class_, allow_local, token_store), **search)
    for result in res["results"]:
        if not result["autonomous"] and result["connection_class"] not in ("R2", "L0"):
            continue
        try:
            conn = await client.get_connection(result["name"])
        except ProtogridError:
            continue
        if _accept(result, conn, secrets, allow_local, token_store):
            return Connectable(result, conn)
    return None


@asynccontextmanager
async def open_session(conn: ConnectionResponse, secrets: Secrets | None = None, *, oauth: OAuthOptions | None = None, client_name: str = "protogrid-sdk", **session_kwargs: Any) -> AsyncIterator[Any]:
    """Async context manager yielding an initialized ``mcp.ClientSession`` for the preferred remote or package.

    Streamable HTTP, SSE and stdio are supported. For R2 servers pass ``oauth``; the one-time
    consent runs inside the first request, later runs use the stored tokens.
    """
    from mcp import ClientSession
    from mcp.types import Implementation

    if conn.get("kind") == "bundle":
        raise ValueError(f"{conn['server']} is only available as a bundle; no transport can be built")
    use_oauth = oauth is not None and conn.get("kind") == "remote" and conn.get("auth_type") in ("oauth2", "unknown")
    _, entry = resolve_entry(conn, secrets, partial=use_oauth)
    from . import __version__  # at call time: the package __init__ imports this module

    info = Implementation(name=client_name, version=__version__)

    if "url" in entry:
        headers = dict(entry.get("headers") or {})
        auth = None
        if use_oauth:
            assert oauth is not None
            # The provider sets Authorization itself; a declared `${TOKEN}` placeholder must not block it.
            for k in [k for k, v in headers.items() if k.lower() == "authorization" and placeholders_in(v)]:
                del headers[k]
            auth = oauth_provider(conn["server"], entry["url"], store=oauth.store, consent=oauth.consent, client_name=oauth.client_name, scope=oauth.scope, client_metadata_url=oauth.client_metadata_url)
        if entry.get("type") == "sse":
            from mcp.client.sse import sse_client

            async with sse_client(entry["url"], headers=headers, auth=auth) as (read, write):
                async with ClientSession(read, write, client_info=info, **session_kwargs) as session:
                    await session.initialize()
                    yield session
            return
        from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

        http = create_mcp_http_client(headers=headers, auth=auth)
        async with http:
            async with streamable_http_client(entry["url"], http_client=http) as (read, write):
                async with ClientSession(read, write, client_info=info, **session_kwargs) as session:
                    await session.initialize()
                    yield session
        return

    from mcp.client.stdio import StdioServerParameters, stdio_client

    env = {k: v for k, v in os.environ.items()}
    env.update(entry.get("env") or {})
    params = StdioServerParameters(command=entry["command"], args=list(entry.get("args") or []), env=env)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write, client_info=info, **session_kwargs) as session:
            await session.initialize()
            yield session
