"""End-to-end OAuth against an in-process authorization server and a protected MCP server:
consent once, then reconnect with stored tokens and no human step."""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

import httpx
import pytest

from protogrid import MemoryTokenStore, OAuthOptions, has_tokens, loopback_consent, open_session

ACCESS = "tok-secret-1"
TOOLS = [{"name": "whoami", "description": "returns the caller", "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}}}]


class Servers:
    def __init__(self) -> None:
        self.as_log: list[str] = []
        self.as_srv = ThreadingHTTPServer(("127.0.0.1", 0), self._as_handler())
        self.as_url = f"http://127.0.0.1:{self.as_srv.server_address[1]}"
        self.rs_srv = ThreadingHTTPServer(("127.0.0.1", 0), self._rs_handler())
        self.rs_url = f"http://127.0.0.1:{self.rs_srv.server_address[1]}"
        for s in (self.as_srv, self.rs_srv):
            threading.Thread(target=s.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.as_srv.shutdown()
        self.rs_srv.shutdown()

    def _as_handler(self):
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def _json(self, code, body):
                b = json.dumps(body).encode()
                self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)

            def _body(self):
                return self.rfile.read(int(self.headers.get("content-length") or 0)).decode()

            def do_GET(self):
                u = urlparse(self.path); outer.as_log.append(f"GET {u.path}")
                if u.path == "/.well-known/oauth-authorization-server":
                    return self._json(200, {"issuer": outer.as_url, "authorization_endpoint": f"{outer.as_url}/authorize", "token_endpoint": f"{outer.as_url}/token", "registration_endpoint": f"{outer.as_url}/register", "response_types_supported": ["code"], "grant_types_supported": ["authorization_code", "refresh_token"], "code_challenge_methods_supported": ["S256"], "token_endpoint_auth_methods_supported": ["none"]})
                if u.path == "/authorize":
                    q = parse_qs(u.query)
                    assert q["code_challenge_method"] == ["S256"] and q["client_id"] == ["client-123"]
                    loc = q["redirect_uri"][0] + "?" + urlencode({"code": "code-xyz", "state": q.get("state", [""])[0]})
                    self.send_response(302); self.send_header("location", loc); self.end_headers(); return
                self.send_response(404); self.end_headers()

            def do_POST(self):
                u = urlparse(self.path); outer.as_log.append(f"POST {u.path}"); body = self._body()
                if u.path == "/register":
                    return self._json(201, {"client_id": "client-123", **json.loads(body)})
                if u.path == "/token":
                    f = parse_qs(body)
                    if f.get("grant_type") == ["authorization_code"]:
                        assert f["code"] == ["code-xyz"] and f.get("code_verifier")
                        return self._json(200, {"access_token": ACCESS, "token_type": "Bearer", "expires_in": 3600, "refresh_token": "r1"})
                    return self._json(400, {"error": "unsupported_grant_type"})
                self.send_response(404); self.end_headers()

        return H

    def _rs_handler(self):
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def _json(self, code, body, extra=None):
                b = json.dumps(body).encode()
                self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b)))
                for k, v in (extra or {}).items(): self.send_header(k, v)
                self.end_headers(); self.wfile.write(b)

            def do_GET(self):
                u = urlparse(self.path)
                if u.path.startswith("/.well-known/oauth-protected-resource"):
                    return self._json(200, {"resource": f"{outer.rs_url}/mcp", "authorization_servers": [outer.as_url]})
                if u.path == "/mcp":
                    self.send_response(405); self.end_headers(); return
                self.send_response(404); self.end_headers()

            def do_DELETE(self):
                self.send_response(200); self.send_header("content-length", "0"); self.end_headers()

            def do_POST(self):
                if self.headers.get("authorization") != f"Bearer {ACCESS}":
                    self.send_response(401); self.send_header("www-authenticate", f'Bearer resource_metadata="{outer.rs_url}/.well-known/oauth-protected-resource"'); self.send_header("content-length", "0"); self.end_headers(); return
                msg = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)))
                if "id" not in msg:  # notification
                    self.send_response(202); self.send_header("content-length", "0"); self.end_headers(); return
                m, rid, params = msg["method"], msg["id"], msg.get("params") or {}
                if m == "initialize":
                    result = {"protocolVersion": params.get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}}, "serverInfo": {"name": "protected", "version": "0"}}
                elif m == "tools/list":
                    result = {"tools": TOOLS}
                elif m == "tools/call":
                    result = {"content": [{"type": "text", "text": f"hello {(params.get('arguments') or {}).get('name', 'agent')}"}]}
                else:
                    return self._json(200, {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"unknown method {m}"}})
                return self._json(200, {"jsonrpc": "2.0", "id": rid, "result": result})

        return H


@pytest.fixture(scope="module")
def servers():
    s = Servers()
    yield s
    s.close()


def conn_for(s: Servers) -> dict:
    return {"server": "test.example/protected", "key": "protected", "kind": "remote", "class": "R2", "autonomous": False, "human_steps": ["oauth_consent_once"], "target": "mcpServers", "content_type": "application/json", "connection": {"mcpServers": {"protected": {"type": "http", "url": f"{s.rs_url}/mcp", "headers": {"Authorization": "${PROTECTED_TOKEN}"}}}}, "secrets": [{"name": "PROTECTED_TOKEN", "where": "header:Authorization"}], "auth_type": "oauth2", "placeholders": "", "next_actions": []}


store = MemoryTokenStore()


async def test_consent_once_then_call_tool(servers: Servers):
    shown: list[str] = []

    async def follow(url: str) -> None:
        shown.append(url)
        async with httpx.AsyncClient(follow_redirects=True) as c:  # the "human" follows the URL to the loopback redirect
            await c.get(url)

    consent = loopback_consent(on_authorization_url=follow)
    try:
        async with open_session(conn_for(servers), {}, oauth=OAuthOptions(store=store, consent=consent, client_name="test")) as session:
            tools = await session.list_tools()
            assert [t.name for t in tools.tools] == ["whoami"]
            out = await session.call_tool("whoami", {"name": "bot"})
            assert out.content[0].text == "hello bot"
    finally:
        consent.close()
    assert len(shown) == 1 and "/authorize" in shown[0]
    assert has_tokens(store, "test.example/protected")
    assert "POST /register" in servers.as_log and servers.as_log.count("POST /token") == 1


async def test_reconnect_without_human(servers: Servers):
    asked = 0

    async def never(url: str) -> None:
        nonlocal asked
        asked += 1

    consent = loopback_consent(on_authorization_url=never)
    try:
        async with open_session(conn_for(servers), {}, oauth=OAuthOptions(store=store, consent=consent)) as session:
            tools = await session.list_tools()
            assert [t.name for t in tools.tools] == ["whoami"]
    finally:
        consent.close()
    assert asked == 0
