"""Sync and async clients for the registry REST API (one method per operation)."""
from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import os
import time

import httpx

from .types import ChangesResponse, CheckResponse, ConnectionResponse, ConnectionTarget, DependenciesResponse, Descriptor, ListToolsResponse, QualityFlag, QualityResponse, SearchResponse, ToolEntry


#: The public registry. Pass ``base_url="http://localhost:8080"`` for a self-hosted or local stack.
DEFAULT_BASE_URL = "https://api.protogrid.dev"
#: Longest the registry holds a check request open, in seconds.
MAX_CHECK_WAIT_S = 25


class ProtogridError(Exception):
    def __init__(self, status: int, body: dict[str, Any] | None, retry_after: float | None = None):
        self.status = status
        self.body = body or {}
        self.retry_after = retry_after
        super().__init__(self.body.get("message") or self.body.get("error") or f"HTTP {status}")

    @property
    def code(self) -> str:
        return str(self.body.get("error") or f"http_{self.status}")


def _search_params(
    q: str,
    limit: int | None,
    class_: Sequence[str] | None,
    transport: str | None,
    category: str | None,
    min_trust: int | None,
    flags: Sequence[str] | None,
    exclude_flags: Sequence[str] | None,
    min_quality: int | None = None,
    quality_flags: Sequence[str] | None = None,
    exclude_quality_flags: Sequence[str] | None = None,
    owner_verified: bool | None = None,
) -> dict[str, str]:
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
    if min_quality is not None:
        p["min_quality"] = str(min_quality)
    if quality_flags:
        p["quality_flags"] = ",".join(quality_flags)
    if exclude_quality_flags:
        p["exclude_quality_flags"] = ",".join(exclude_quality_flags)
    if owner_verified is not None:
        p["owner_verified"] = "true" if owner_verified else "false"
    return p


def _changes_params(limit: int | None, before: int | None) -> dict[str, str] | None:
    p: dict[str, str] = {}
    if limit is not None:
        p["limit"] = str(limit)
    if before is not None:
        p["before"] = str(before)
    return p or None


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
    def _wait_left(deadline: float) -> int:
        return max(0, min(MAX_CHECK_WAIT_S, int(deadline - time.monotonic())))

    @staticmethod
    def _pending(c: CheckResponse) -> bool:
        return c["status"] in ("queued", "running")

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

    def search(
        self,
        q: str,
        *,
        limit: int | None = None,
        class_: Sequence[str] | None = None,
        transport: str | None = None,
        category: str | None = None,
        min_trust: int | None = None,
        flags: Sequence[str] | None = None,
        exclude_flags: Sequence[str] | None = None,
        min_quality: int | None = None,
        quality_flags: Sequence[QualityFlag] | None = None,
        exclude_quality_flags: Sequence[QualityFlag] | None = None,
        owner_verified: bool | None = None,
    ) -> SearchResponse:
        """Searches servers by intent. ``min_quality`` leaves unscored servers out; ``exclude_quality_flags``
        such as ``["known-vulns"]`` drops servers whose dependency checks fail; ``owner_verified=True`` keeps
        servers whose owner proved control of the namespace (not an audit)."""
        return self._get("/v1/search", _search_params(q, limit, class_, transport, category, min_trust, flags, exclude_flags, min_quality, quality_flags, exclude_quality_flags, owner_verified))

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

    def get_quality(self, name: str, *, days: int | None = None) -> QualityResponse:
        """The quality block, the verified owner and the daily score for the last ``days`` (default 90, up to 400)."""
        return self._get(self._server_path(name, "/quality"), {"days": str(days)} if days is not None else None)

    def get_changes(self, name: str, *, limit: int | None = None, before: int | None = None) -> ChangesResponse:
        """Tool-definition history, newest first; pass ``next_before`` back as ``before`` for the next page."""
        return self._get(self._server_path(name, "/changes"), _changes_params(limit, before))

    def get_dependencies(self, name: str) -> DependenciesResponse:
        """npm and PyPI packages of the server with their resolved dependency graphs and known advisories."""
        return self._get(self._server_path(name, "/dependencies"))

    def get_connection(self, name: str, target: ConnectionTarget = "mcpServers") -> ConnectionResponse:
        return self._get(self._server_path(name, "/connection"), {"target": target})

    def check(self, url: str, *, wait: float = 90.0, fresh: bool = False) -> CheckResponse:
        """Checks a remote MCP server URL, listed or not: one credential-free probe (no tool is
        called), the quality checks and the readiness for the Claude and OpenAI directories.

        Waits for the result up to ``wait`` seconds (0 returns at once) and returns the check as it
        stands then; read a ``queued`` or ``running`` one later with :meth:`get_check`. The same URL
        within a few minutes returns the recent check, unless ``fresh`` is set with an API key (for CI
        right after a deploy; it counts against the hourly allowance, and anonymous calls ignore it).
        A refused URL raises ``invalid_url``; an exhausted hourly allowance raises
        ``check_quota_exceeded`` with ``retry_after``.
        """
        deadline = time.monotonic() + wait
        w = self._wait_left(deadline)
        res = self._http.post("/v1/check", params={"wait": str(w)}, json={"url": url, "fresh": True} if fresh else {"url": url}, timeout=self._timeout + w)
        _raise_for(res)
        c: CheckResponse = res.json()
        while self._pending(c) and self._wait_left(deadline) > 0:
            c = self.get_check(c["id"], wait=self._wait_left(deadline))
        return c

    def get_check(self, id: str, *, wait: int = 0) -> CheckResponse:
        """Reads a check; ``wait`` (up to 25 s) holds the request until it finishes. Kept 30 days."""
        from urllib.parse import quote

        w = max(0, min(MAX_CHECK_WAIT_S, wait))
        res = self._http.get(f"/v1/check/{quote(id, safe='')}", params={"wait": str(w)} if w else None, timeout=self._timeout + w)
        _raise_for(res)
        return res.json()


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

    async def search(
        self,
        q: str,
        *,
        limit: int | None = None,
        class_: Sequence[str] | None = None,
        transport: str | None = None,
        category: str | None = None,
        min_trust: int | None = None,
        flags: Sequence[str] | None = None,
        exclude_flags: Sequence[str] | None = None,
        min_quality: int | None = None,
        quality_flags: Sequence[QualityFlag] | None = None,
        exclude_quality_flags: Sequence[QualityFlag] | None = None,
        owner_verified: bool | None = None,
    ) -> SearchResponse:
        """Searches servers by intent. ``min_quality`` leaves unscored servers out; ``exclude_quality_flags``
        such as ``["known-vulns"]`` drops servers whose dependency checks fail; ``owner_verified=True`` keeps
        servers whose owner proved control of the namespace (not an audit)."""
        return await self._get("/v1/search", _search_params(q, limit, class_, transport, category, min_trust, flags, exclude_flags, min_quality, quality_flags, exclude_quality_flags, owner_verified))

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

    async def get_quality(self, name: str, *, days: int | None = None) -> QualityResponse:
        """The quality block, the verified owner and the daily score for the last ``days`` (default 90, up to 400)."""
        return await self._get(self._server_path(name, "/quality"), {"days": str(days)} if days is not None else None)

    async def get_changes(self, name: str, *, limit: int | None = None, before: int | None = None) -> ChangesResponse:
        """Tool-definition history, newest first; pass ``next_before`` back as ``before`` for the next page."""
        return await self._get(self._server_path(name, "/changes"), _changes_params(limit, before))

    async def get_dependencies(self, name: str) -> DependenciesResponse:
        """npm and PyPI packages of the server with their resolved dependency graphs and known advisories."""
        return await self._get(self._server_path(name, "/dependencies"))

    async def get_connection(self, name: str, target: ConnectionTarget = "mcpServers") -> ConnectionResponse:
        return await self._get(self._server_path(name, "/connection"), {"target": target})

    async def check(self, url: str, *, wait: float = 90.0, fresh: bool = False) -> CheckResponse:
        """Checks a remote MCP server URL, listed or not: one credential-free probe (no tool is
        called), the quality checks and the readiness for the Claude and OpenAI directories.

        Waits for the result up to ``wait`` seconds (0 returns at once) and returns the check as it
        stands then; read a ``queued`` or ``running`` one later with :meth:`get_check`. The same URL
        within a few minutes returns the recent check, unless ``fresh`` is set with an API key (for CI
        right after a deploy; it counts against the hourly allowance, and anonymous calls ignore it).
        A refused URL raises ``invalid_url``; an exhausted hourly allowance raises
        ``check_quota_exceeded`` with ``retry_after``.
        """
        deadline = time.monotonic() + wait
        w = self._wait_left(deadline)
        res = await self._http.post("/v1/check", params={"wait": str(w)}, json={"url": url, "fresh": True} if fresh else {"url": url}, timeout=self._timeout + w)
        _raise_for(res)
        c: CheckResponse = res.json()
        while self._pending(c) and self._wait_left(deadline) > 0:
            c = await self.get_check(c["id"], wait=self._wait_left(deadline))
        return c

    async def get_check(self, id: str, *, wait: int = 0) -> CheckResponse:
        """Reads a check; ``wait`` (up to 25 s) holds the request until it finishes. Kept 30 days."""
        from urllib.parse import quote

        w = max(0, min(MAX_CHECK_WAIT_S, wait))
        res = await self._http.get(f"/v1/check/{quote(id, safe='')}", params={"wait": str(w)} if w else None, timeout=self._timeout + w)
        _raise_for(res)
        return res.json()
