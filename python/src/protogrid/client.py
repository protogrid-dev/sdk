"""Sync and async clients for the registry REST API (one method per operation)."""
from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import os

import httpx

from .types import ConnectionResponse, ConnectionTarget, Descriptor, ListToolsResponse, SearchResponse, ToolEntry


#: The public registry. Pass ``base_url="http://localhost:8080"`` for a self-hosted or local stack.
DEFAULT_BASE_URL = "https://api.protogrid.dev"


class ProtogridError(Exception):
    def __init__(self, status: int, body: dict[str, Any] | None, retry_after: float | None = None):
        self.status = status
        self.body = body or {}
        self.retry_after = retry_after
        super().__init__(self.body.get("message") or self.body.get("error") or f"HTTP {status}")

    @property
    def code(self) -> str:
        return str(self.body.get("error") or f"http_{self.status}")


def _search_params(q: str, limit: int | None, class_: Sequence[str] | None, transport: str | None, category: str | None, min_trust: int | None, flags: Sequence[str] | None, exclude_flags: Sequence[str] | None) -> dict[str, str]:
    p: dict[str, str] = {"q": q}
    if limit is not None:
        p["limit"] = str(limit)
    if class_:
        p["class"] = ",".join(class_)
    if transport:
        p["transport"] = transport
    if category:
        p["category"] = category
    if min_trust is not None:
        p["min_trust"] = str(min_trust)
    if flags:
        p["flags"] = ",".join(flags)
    if exclude_flags:
        p["exclude_flags"] = ",".join(exclude_flags)
    return p


def _raise_for(res: httpx.Response) -> None:
    if res.is_success:
        return
    try:
        body = res.json()
    except ValueError:
        body = {"error": f"http_{res.status_code}", "message": res.text[:200]}
    ra = res.headers.get("retry-after")
    raise ProtogridError(res.status_code, body, float(ra) if ra else None)


class _Base:
    def __init__(self, base_url: str = DEFAULT_BASE_URL, *, api_key: str | None = None, timeout: float = 15.0, user_agent: str | None = None):
        self.base_url = base_url.rstrip("/")
        # Defaults to PROTOGRID_API_KEY; pass api_key="" to send none. Keys: https://protogrid.dev/account
        if api_key is None:
            api_key = os.environ.get("PROTOGRID_API_KEY")
        headers = {"accept": "application/json"}
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"
        if user_agent:
            headers["user-agent"] = user_agent
        self._headers = headers
        self._timeout = timeout

    @staticmethod
    def _server_path(name: str, suffix: str = "") -> str:
        from urllib.parse import quote

        return f"/v1/servers/{quote(name, safe='')}{suffix}"


class ProtogridClient(_Base):
    """Synchronous client."""

    def __init__(self, base_url: str = DEFAULT_BASE_URL, *, api_key: str | None = None, timeout: float = 15.0, user_agent: str | None = None, transport: httpx.BaseTransport | None = None):
        super().__init__(base_url, api_key=api_key, timeout=timeout, user_agent=user_agent)
        self._http = httpx.Client(base_url=self.base_url, headers=self._headers, timeout=timeout, transport=transport)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> ProtogridClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _get(self, path: str, params: dict[str, str] | None = None) -> Any:
        res = self._http.get(path, params=params)
        _raise_for(res)
        return res.json()

    def search(self, q: str, *, limit: int | None = None, class_: Sequence[str] | None = None, transport: str | None = None, category: str | None = None, min_trust: int | None = None, flags: Sequence[str] | None = None, exclude_flags: Sequence[str] | None = None) -> SearchResponse:
        return self._get("/v1/search", _search_params(q, limit, class_, transport, category, min_trust, flags, exclude_flags))

    def get_server(self, name: str, *, schemas: bool = False) -> Descriptor:
        return self._get(self._server_path(name), {"schemas": "true"} if schemas else None)

    def list_tools(self, name: str, *, limit: int | None = None, cursor: str | None = None) -> ListToolsResponse:
        p: dict[str, str] = {}
        if limit is not None:
            p["limit"] = str(limit)
        if cursor:
            p["cursor"] = cursor
        return self._get(self._server_path(name, "/tools"), p or None)

    def list_all_tools(self, name: str) -> list[ToolEntry]:
        out: list[ToolEntry] = []
        cursor: str | None = None
        while True:
            page = self.list_tools(name, limit=100, cursor=cursor)
            out.extend(page["tools"])
            cursor = page.get("next_cursor")
            if not cursor:
                return out

    def get_connection(self, name: str, target: ConnectionTarget = "mcpServers") -> ConnectionResponse:
        return self._get(self._server_path(name, "/connection"), {"target": target})


class AsyncProtogridClient(_Base):
    """Asynchronous client (same methods, awaitable)."""

    def __init__(self, base_url: str = DEFAULT_BASE_URL, *, api_key: str | None = None, timeout: float = 15.0, user_agent: str | None = None, transport: httpx.AsyncBaseTransport | None = None):
        super().__init__(base_url, api_key=api_key, timeout=timeout, user_agent=user_agent)
        self._http = httpx.AsyncClient(base_url=self.base_url, headers=self._headers, timeout=timeout, transport=transport)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> AsyncProtogridClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def _get(self, path: str, params: dict[str, str] | None = None) -> Any:
        res = await self._http.get(path, params=params)
        _raise_for(res)
        return res.json()

    async def search(self, q: str, *, limit: int | None = None, class_: Sequence[str] | None = None, transport: str | None = None, category: str | None = None, min_trust: int | None = None, flags: Sequence[str] | None = None, exclude_flags: Sequence[str] | None = None) -> SearchResponse:
        return await self._get("/v1/search", _search_params(q, limit, class_, transport, category, min_trust, flags, exclude_flags))

    async def get_server(self, name: str, *, schemas: bool = False) -> Descriptor:
        return await self._get(self._server_path(name), {"schemas": "true"} if schemas else None)

    async def list_tools(self, name: str, *, limit: int | None = None, cursor: str | None = None) -> ListToolsResponse:
        p: dict[str, str] = {}
        if limit is not None:
            p["limit"] = str(limit)
        if cursor:
            p["cursor"] = cursor
        return await self._get(self._server_path(name, "/tools"), p or None)

    async def list_all_tools(self, name: str) -> list[ToolEntry]:
        out: list[ToolEntry] = []
        cursor: str | None = None
        while True:
            page = await self.list_tools(name, limit=100, cursor=cursor)
            out.extend(page["tools"])
            cursor = page.get("next_cursor")
            if not cursor:
                return out

    async def get_connection(self, name: str, target: ConnectionTarget = "mcpServers") -> ConnectionResponse:
        return await self._get(self._server_path(name, "/connection"), {"target": target})
