import json

import httpx
import pytest

from protogrid import (
    ProtogridClient,
    ProtogridError,
    MemoryTokenStore,
    MissingSecretsError,
    find_connectable,
    placeholders_in,
    resolve_entry,
    secrets_satisfied,
    substitute_secrets,
    to_fastmcp_transport,
    to_mcp_servers,
)

CONN = {
    "server": "io.github.acme/acme-mcp",
    "key": "acme-mcp",
    "kind": "remote",
    "class": "R1",
    "autonomous": True,
    "human_steps": [],
    "target": "mcpServers",
    "content_type": "application/json",
    "connection": {"mcpServers": {"acme-mcp": {"type": "http", "url": "https://mcp.acme.dev/mcp", "headers": {"Authorization": "Bearer ${ACME_TOKEN}"}}}},
    "secrets": [{"name": "ACME_TOKEN", "where": "header:Authorization"}],
    "auth_type": "api_key",
    "placeholders": "",
    "next_actions": [],
}


def test_secrets_roundtrip():
    assert placeholders_in(CONN["connection"]) == ["ACME_TOKEN"]
    out = substitute_secrets(CONN["connection"], {"ACME_TOKEN": "sk-1"})
    assert out["mcpServers"]["acme-mcp"]["headers"]["Authorization"] == "Bearer sk-1"
    assert CONN["connection"]["mcpServers"]["acme-mcp"]["headers"]["Authorization"] == "Bearer ${ACME_TOKEN}"
    with pytest.raises(MissingSecretsError) as e:
        substitute_secrets(CONN["connection"], {})
    assert e.value.missing == ["ACME_TOKEN"]
    assert placeholders_in(substitute_secrets(CONN["connection"], {}, partial=True)) == ["ACME_TOKEN"]
    assert secrets_satisfied(CONN, {}) is False
    assert secrets_satisfied(CONN, {"ACME_TOKEN": "x"}) is True


def test_formatters():
    assert to_mcp_servers(CONN, {"ACME_TOKEN": "x"}) == {"mcpServers": {"acme-mcp": {"type": "http", "url": "https://mcp.acme.dev/mcp", "headers": {"Authorization": "Bearer x"}}}}
    assert to_fastmcp_transport(CONN, {"ACME_TOKEN": "x"}) == {"kind": "streamable-http", "url": "https://mcp.acme.dev/mcp", "headers": {"Authorization": "Bearer x"}}
    pkg = {**CONN, "kind": "package", "connection": {"mcpServers": {"acme-mcp": {"command": "npx", "args": ["-y", "x"], "env": {"T": "${T}"}}}}}
    assert to_fastmcp_transport(pkg, {"T": "v"}) == {"kind": "stdio", "command": "npx", "args": ["-y", "x"], "env": {"T": "v"}}
    assert resolve_entry(pkg, {"T": "v"})[0] == "acme-mcp"


def _fake(request: httpx.Request) -> httpx.Response:
    p = request.url.path
    if p == "/v1/search":
        return httpx.Response(200, json={"query": "x", "mode": "keyword", "count": 2, "results": [
            {"name": "a/oauth", "title": None, "description": "", "connection_class": "R2", "autonomous": False, "human_steps": ["oauth_consent_once"], "categories": [], "trust_score": 50, "trust_flags": [], "tool_count": 1, "score": 1, "matched_tools": []},
            {"name": "io.github.acme/acme-mcp", "title": None, "description": "", "connection_class": "R1", "autonomous": True, "human_steps": [], "categories": [], "trust_score": 90, "trust_flags": [], "tool_count": 3, "score": 0.9, "matched_tools": []},
        ], "next_actions": []})
    if p.endswith("/connection"):
        return httpx.Response(200, json=CONN)
    if "nothing" in p:
        return httpx.Response(404, json={"error": "not_found", "server": "nothing"})
    if "limited" in p:
        return httpx.Response(429, headers={"retry-after": "7"})
    if p.endswith("/tools"):
        cur = request.url.params.get("cursor")
        return httpx.Response(200, json={"server": "s", "count": 1, "tools": [{"name": "b" if cur else "a"}], "next_cursor": None if cur else "a", "next_actions": []})
    return httpx.Response(200, json={})


def test_client_urls_and_errors():
    seen = []

    def handler(req):
        seen.append(str(req.url) + "|" + req.headers.get("authorization", ""))
        return _fake(req)

    c = ProtogridClient("http://reg/", api_key="k", transport=httpx.MockTransport(handler))
    c.search("send email", class_=["R0", "R1"], min_trust=80, exclude_flags=["multi-version-spam", "duplicate-repo"])
    assert seen[-1] == "http://reg/v1/search?q=send+email&class=R0%2CR1&min_trust=80&exclude_flags=multi-version-spam%2Cduplicate-repo|Bearer k"
    c.list_tools("io.github.acme/acme-mcp", limit=5, cursor="z")
    assert seen[-1].startswith("http://reg/v1/servers/io.github.acme%2Facme-mcp/tools?limit=5&cursor=z")
    assert [t["name"] for t in c.list_all_tools("s")] == ["a", "b"]
    with pytest.raises(ProtogridError) as e:
        c.get_server("nothing")
    assert (e.value.status, e.value.code) == (404, "not_found")
    with pytest.raises(ProtogridError) as e2:
        c.get_server("limited")
    assert e2.value.retry_after == 7.0


def test_find_connectable():
    c = ProtogridClient("http://reg", transport=httpx.MockTransport(_fake))
    assert find_connectable(c, "x") is None
    found = find_connectable(c, "x", secrets={"ACME_TOKEN": "s"})
    assert found is not None and found.result["name"] == "io.github.acme/acme-mcp"
    store = MemoryTokenStore()
    store.set("a/oauth:tokens", {"access_token": "t", "token_type": "Bearer"})
    # R2 with stored tokens: the fake returns the R1 block for every server, so secrets must still be present.
    found2 = find_connectable(c, "x", secrets={"ACME_TOKEN": "s"}, token_store=store)
    assert found2 is not None and found2.result["name"] == "a/oauth"
