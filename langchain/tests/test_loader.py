"""load_tools end to end: a scripted registry, and a real MCP server over HTTP on a local port."""
from __future__ import annotations

import socket
import threading
import time
from typing import Any

import httpx
import pytest
import uvicorn
from fastmcp import FastMCP
from protogrid import AsyncProtogridClient

from langchain_protogrid import LoadReport, NoServerLoaded, Rules, load_tools, tool_set_hash

TOKEN = "s3cret"
server = FastMCP("mail")
SEEN_AUTH: list[str | None] = []


@server.tool
def send(to: str) -> str:
    """Send a test mail."""
    return f"sent to {to}"


@server.tool
def ping() -> str:
    """Answer pong."""
    return "pong"


class AuthSpy:
    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] == "http":
            SEEN_AUTH.append(dict(scope["headers"]).get(b"authorization", b"").decode() or None)
        await self.app(scope, receive, send)


@pytest.fixture(scope="module")
def mcp_url():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    srv = uvicorn.Server(uvicorn.Config(AuthSpy(server.http_app()), host="127.0.0.1", port=port, log_level="error"))
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()
    while not srv.started:
        time.sleep(0.02)
    yield f"http://127.0.0.1:{port}/mcp"
    srv.should_exit = True
    t.join(5)


async def checked_hash() -> str:
    """The hash of the test server's tools, read in process (what protogrid would have recorded)."""
    from fastmcp import Client

    async with Client(server) as c:
        return tool_set_hash([t.model_dump(mode="json", by_alias=True, exclude_unset=True) for t in await c.list_tools()]) or ""


def fake_registry(url: str, *, gates: dict[str, dict[str, Any]] | None = None, kinds: dict[str, str] | None = None, tools_hash: str = "h1", order: list[str] | None = None) -> tuple[AsyncProtogridClient, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    async def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        path = req.url.path
        if path == "/v1/search":
            return httpx.Response(200, json={"results": [{"name": n} for n in (order or [])]})
        name = httpx.URL(path).path.removeprefix("/v1/servers/").rsplit("/", 1)[0]
        if path.endswith("/gate"):
            g = (gates or {}).get(name, {})
            return httpx.Response(200, json={"server": name, "pass": g.get("pass", True), "failed": g.get("failed", []), "quality": {"score": 90}, "class": "R1", "owner_verified": False, "tools_hash": tools_hash})
        if path.endswith("/connection"):
            kind = (kinds or {}).get(name, "remote")
            conn = {"mcpServers": {"mail": {"type": "http", "url": url, "headers": {"Authorization": "Bearer ${MAIL_TOKEN}"}}}} if kind == "remote" else {"mcpServers": {"mail": {"command": "npx", "args": ["-y", "mail-mcp"]}}}
            return httpx.Response(200, json={"server": name, "key": "mail", "kind": kind, "class": "R1", "connection": conn, "secrets": [{"name": "MAIL_TOKEN", "where": "header:Authorization"}]})
        return httpx.Response(404, json={"error": "not_found"})

    return AsyncProtogridClient(transport=httpx.MockTransport(handler)), seen


async def test_loads_a_passing_server_with_its_secret_and_calls_it(mcp_url):
    reg, seen = fake_registry(mcp_url)
    report = LoadReport()
    SEEN_AUTH.clear()
    tools = await load_tools(servers=["io.github.acme/mail"], secrets={"MAIL_TOKEN": TOKEN}, registry=reg, report=report)
    assert sorted(t.name for t in tools) == ["mail_ping", "mail_send"]
    assert tools[0].metadata["protogrid_server"] == "io.github.acme/mail" and tools[0].metadata["protogrid_tools_hash"] == "h1"
    send = next(t for t in tools if t.name == "mail_send")
    assert "sent to a@b.c" in str(await send.ainvoke({"to": "a@b.c"}))
    assert f"Bearer {TOKEN}" in SEEN_AUTH
    # The secret went to the server only, never to the registry.
    assert all(TOKEN not in str(r.url) and TOKEN.encode() not in r.content and all(TOKEN not in v for v in r.headers.values()) for r in seen)
    assert report.loaded == {"io.github.acme/mail": "h1"}


async def test_passes_over_what_fails_and_says_why(mcp_url):
    reg, _ = fake_registry(mcp_url, gates={"io.github.acme/bad": {"pass": False, "failed": [{"rule": "no_fail", "detail": "tools.hidden_text fails"}]}}, kinds={"io.github.acme/local": "package"})
    report = LoadReport()
    with pytest.raises(NoServerLoaded) as e:
        await load_tools(servers=["io.github.acme/bad", "io.github.acme/local", "io.github.acme/nokey"], secrets={}, registry=reg, report=report)
    assert [(s.server, s.reason) for s in e.value.report.skipped] == [
        ("io.github.acme/bad", "tools.hidden_text fails"),
        ("io.github.acme/local", "not a remote server (local packages are never loaded)"),
        ("io.github.acme/nokey", "needs MAIL_TOKEN, not in secrets"),
    ]


async def test_tries_search_results_in_order_and_stops_at_max_servers(mcp_url):
    reg, seen = fake_registry(mcp_url, gates={"io.github.acme/first": {"pass": False, "failed": [{"rule": "min_quality", "detail": "quality 50 is under 70"}]}}, order=["io.github.acme/first", "io.github.acme/second", "io.github.acme/third"])
    report = LoadReport()
    await load_tools("send mail", rules=Rules(min_quality=70), secrets={"MAIL_TOKEN": TOKEN}, registry=reg, report=report)
    assert list(report.loaded) == ["io.github.acme/second"]
    assert not any("third" in str(r.url) for r in seen)
    search = next(r for r in seen if r.url.path == "/v1/search")
    assert search.url.params["class"] == "R0,R1" and search.url.params["q"] == "send mail"
    assert "paid" not in search.url.params


async def test_paid_false_reaches_search_and_the_gate(mcp_url):
    reg, seen = fake_registry(mcp_url, order=["io.github.acme/mail"])
    await load_tools("send mail", rules=Rules(paid=False), secrets={"MAIL_TOKEN": TOKEN}, registry=reg)
    assert next(r for r in seen if r.url.path == "/v1/search").url.params["paid"] == "false"
    assert next(r for r in seen if r.url.path.endswith("/gate")).url.params["paid"] == "false"


async def test_pins_and_strict_tools(mcp_url):
    good = await checked_hash()
    reg, _ = fake_registry(mcp_url, tools_hash=good)
    assert len(await load_tools(servers=["io.github.acme/mail"], secrets={"MAIL_TOKEN": TOKEN}, registry=reg, pins={"io.github.acme/mail": good}, strict_tools=True)) == 2
    with pytest.raises(NoServerLoaded, match="tools changed since pinned"):
        await load_tools(servers=["io.github.acme/mail"], secrets={"MAIL_TOKEN": TOKEN}, registry=reg, pins={"io.github.acme/mail": "old"})
    stale, _ = fake_registry(mcp_url, tools_hash="what-protogrid-saw-before")
    with pytest.raises(NoServerLoaded, match="lists tools other than the ones protogrid checked"):
        await load_tools(servers=["io.github.acme/mail"], secrets={"MAIL_TOKEN": TOKEN}, registry=stale, strict_tools=True)


async def test_an_unreachable_server_is_passed_over():
    reg, _ = fake_registry("http://127.0.0.1:9/mcp")
    with pytest.raises(NoServerLoaded, match="could not connect"):
        await load_tools(servers=["io.github.acme/mail"], secrets={"MAIL_TOKEN": TOKEN}, registry=reg)


async def test_needs_a_query_or_servers():
    with pytest.raises(ValueError):
        await load_tools()


async def test_an_agent_calls_a_loaded_tool(mcp_url):
    from langchain.agents import create_agent
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage

    class Model(GenericFakeChatModel):
        def bind_tools(self, tools: Any, **_: Any) -> "Model":
            return self

    reg, _ = fake_registry(mcp_url)
    tools = await load_tools(servers=["io.github.acme/mail"], secrets={"MAIL_TOKEN": TOKEN}, registry=reg)
    model = Model(messages=iter([AIMessage(content="", tool_calls=[{"name": "mail_send", "args": {"to": "ops@acme.dev"}, "id": "c1"}]), AIMessage(content="done")]))
    agent = create_agent(model=model, tools=tools)
    result = await agent.ainvoke({"messages": [{"role": "user", "content": "mail ops"}]})
    tool_messages = [m for m in result["messages"] if m.type == "tool"]
    assert len(tool_messages) == 1 and "sent to ops@acme.dev" in str(tool_messages[0].content)
