"""Load the tools of MCP servers that pass your rules, straight from each server (no proxy in between)."""
from __future__ import annotations

import logging
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from fastmcp.client import Client
from fastmcp.client.transports import SSETransport, StreamableHttpTransport
from langchain.mcp import MCPAdapter, as_langchain_tool
from langchain_core.tools import BaseTool
from protogrid import AsyncProtogridClient, ProtogridError
from protogrid.connect import resolve_entry
from protogrid.secrets import placeholders_in

from .rules import DEFAULT_RULES, Rules
from .tools_hash import tool_set_hash

log = logging.getLogger("langchain_protogrid")

Secrets = Mapping[str, str | None]


@dataclass
class Skipped:
    server: str
    reason: str


@dataclass
class LoadReport:
    """What `load_tools` did: the servers loaded, with the tool-set hash protogrid checked, and those it passed over."""

    loaded: dict[str, str | None] = field(default_factory=dict)
    skipped: list[Skipped] = field(default_factory=list)


class NoServerLoaded(RuntimeError):
    def __init__(self, report: LoadReport):
        reasons = "; ".join(f"{s.server}: {s.reason}" for s in report.skipped) or "no candidates"
        super().__init__(f"no MCP server passed the rules and connected ({reasons})")
        self.report = report


_TOOL_NAME = re.compile(r"[^A-Za-z0-9_-]")


def _tool_name(key: str, name: str) -> str:
    """`<server key>_<tool>`, in the characters and length every chat model accepts for a tool name."""
    return _TOOL_NAME.sub("_", f"{key}_{name}")[:64]


def _client(entry: Mapping[str, Any], *, oauth: bool) -> Client[Any]:
    url = entry.get("url")
    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        raise ValueError("not a remote server")
    headers = dict(entry.get("headers") or {})
    auth = "oauth" if oauth else None
    transport = SSETransport(url, headers=headers, auth=auth) if entry.get("type") == "sse" else StreamableHttpTransport(url, headers=headers, auth=auth)
    return Client(transport)


async def load_tools(
    query: str | None = None,
    *,
    servers: Sequence[str] | None = None,
    rules: Rules = DEFAULT_RULES,
    secrets: Secrets | None = None,
    max_servers: int = 1,
    candidates: int = 10,
    pins: Mapping[str, str] | None = None,
    strict_tools: bool = False,
    api_key: str | None = None,
    base_url: str | None = None,
    registry: AsyncProtogridClient | None = None,
    connect: Callable[[Mapping[str, Any], bool], Client[Any]] | None = None,
    report: LoadReport | None = None,
) -> list[BaseTool]:
    """The LangChain tools of up to ``max_servers`` MCP servers that pass ``rules``.

    Give a ``query`` (what the tools should do: the best ``candidates`` search results are tried in order) or a list
    of ``servers`` by registry name. Each server goes through protogrid's gate with ``rules``; one that passes is
    connected to directly, with the ``${NAME}`` placeholders of its connection filled from ``secrets`` (they never
    leave your process), and its tools are returned named ``<server key>_<tool>``. A server that needs a secret you
    did not give, a sign-in your rules do not allow, or a local package is passed over.

    ``pins`` maps a server name to the tool-set hash you reviewed (``tools_hash`` of the gate): a server whose
    checked tools changed since is passed over. With ``strict_tools``, the tools the server lists right now must be
    the ones protogrid checked, so a change made after protogrid's last probe is caught too.

    Raises :class:`NoServerLoaded` when none could be loaded; pass a :class:`LoadReport` to see why each server was
    passed over either way.
    """
    if (query is None) == (servers is None):
        raise ValueError("give either a query or a list of servers")
    out = report if report is not None else LoadReport()
    own = registry is None
    reg = registry or AsyncProtogridClient(**{k: v for k, v in {"api_key": api_key, "base_url": base_url}.items() if v is not None}, user_agent="langchain-protogrid")
    tools: list[BaseTool] = []
    try:
        names = list(servers) if servers is not None else [r["name"] for r in (await reg.search(query or "", limit=candidates, class_=[c for c in rules.classes if c != "L0"], paid=rules.paid))["results"]]
        for name in names:
            if len(out.loaded) >= max_servers:
                break
            loaded = await _load_one(reg, name, rules, secrets or {}, pins or {}, strict_tools, connect or (lambda e, o: _client(e, oauth=o)), out)
            tools.extend(loaded)
    finally:
        if own:
            await reg.aclose()
    if not out.loaded:
        raise NoServerLoaded(out)
    return tools


async def _load_one(
    reg: AsyncProtogridClient,
    name: str,
    rules: Rules,
    secrets: Secrets,
    pins: Mapping[str, str],
    strict_tools: bool,
    connect: Callable[[Mapping[str, Any], bool], Client[Any]],
    out: LoadReport,
) -> list[BaseTool]:
    def skip(reason: str) -> list[BaseTool]:
        log.info("protogrid: passed over %s: %s", name, reason)
        out.skipped.append(Skipped(name, reason))
        return []

    try:
        gate = await reg.gate(name, **rules.gate_kwargs())
    except ProtogridError as e:
        return skip(f"registry answered {e.status} ({e.code})")
    if not gate["pass"]:
        return skip("; ".join(f["detail"] for f in gate["failed"]))
    checked = gate.get("tools_hash")
    if name in pins and pins[name] != checked:
        return skip(f"tools changed since pinned ({pins[name]} is now {checked})")
    try:
        conn = await reg.get_connection(name, "mcpServers")
    except ProtogridError as e:
        return skip(f"no connection offered ({e.code})")
    if conn.get("kind") != "remote":
        return skip("not a remote server (local packages are never loaded)")
    _, raw = resolve_entry(conn, {}, partial=True)
    missing = [p for p in placeholders_in(raw) if not secrets.get(p)]
    if missing:
        return skip(f"needs {', '.join(missing)}, not in secrets")
    key, entry = resolve_entry(conn, secrets)
    oauth = conn.get("class") == "R2"
    try:
        adapter = MCPAdapter(connect(entry, oauth))
        # One listing serves both the comparison and the tools, as MCPAdapter.list_tools would do it.
        async with adapter:
            listed = await adapter.client.list_tools()
            if strict_tools:
                live = tool_set_hash([t.model_dump(mode="json", by_alias=True, exclude_unset=True) for t in listed])
                if live != checked:
                    return skip(f"lists tools other than the ones protogrid checked ({live} against {checked})")
            found = [await as_langchain_tool(t, adapter.client) for t in listed]
    except Exception as e:  # noqa: BLE001 - a server that cannot be reached is passed over, not fatal
        return skip(f"could not connect: {type(e).__name__}: {e}")
    for t in found:
        t.name = _tool_name(key, t.name)
        t.metadata = {**(t.metadata or {}), "protogrid_server": name, "protogrid_tools_hash": checked}
    out.loaded[name] = checked
    return list(found)
