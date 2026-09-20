"""OAuth for R2 servers (D4: the agent holds the tokens; the registry only exposes metadata).

The official ``mcp`` package runs the whole client flow (protected-resource and
authorization-server discovery, dynamic registration or Client ID Metadata Documents, PKCE,
refresh) inside its ``OAuthClientProvider``, an ``httpx.Auth``. This module supplies that
provider from a pluggable :class:`TokenStore` and the single human step, the one-time consent.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qs, urlparse


class TokenStore(Protocol):
    """Minimal key/value store; keys are ``"<server name>:<tokens|client>"``. Bring your own."""

    def get(self, key: str) -> Any | None: ...
    def set(self, key: str, value: Any) -> None: ...
    def delete(self, key: str) -> None: ...


class MemoryTokenStore:
    def __init__(self) -> None:
        self._d: dict[str, Any] = {}

    def get(self, key: str) -> Any | None:
        return self._d.get(key)

    def set(self, key: str, value: Any) -> None:
        self._d[key] = value

    def delete(self, key: str) -> None:
        self._d.pop(key, None)


class FileTokenStore:
    """One JSON file, mode 0600. Fine for a single agent process; not for shared hosts."""

    def __init__(self, path: str | os.PathLike[str]):
        self.path = Path(path)

    def _read(self) -> dict[str, Any]:
        try:
            return json.loads(self.path.read_text())
        except (OSError, ValueError):
            return {}

    def _write(self, d: dict[str, Any]) -> None:
        self.path.write_text(json.dumps(d, indent=2))
        os.chmod(self.path, 0o600)

    def get(self, key: str) -> Any | None:
        return self._read().get(key)

    def set(self, key: str, value: Any) -> None:
        d = self._read()
        d[key] = value
        self._write(d)

    def delete(self, key: str) -> None:
        d = self._read()
        d.pop(key, None)
        self._write(d)


def has_tokens(store: TokenStore, server_name: str) -> bool:
    """True when the store already holds tokens for ``server_name`` (no human step needed now)."""
    return store.get(f"{server_name}:tokens") is not None


# ---------- consent ----------


@dataclass
class ConsentHandler:
    """How the one-time consent happens: show the URL, then hand back the code and state."""

    redirect_url: str
    on_authorization_url: Callable[[str], Awaitable[None]]
    wait_for_code: Callable[[], Awaitable[tuple[str, str | None]]]
    close: Callable[[], None] | None = None


def loopback_consent(*, host: str = "127.0.0.1", port: int = 0, path: str = "/callback", on_authorization_url: Callable[[str], Awaitable[None]] | None = None, timeout: float = 300.0, success_html: str = "<!doctype html><title>Authorized</title><p>Authorization received. You can close this tab.</p>") -> ConsentHandler:
    """Loopback redirect receiver (RFC 8252 §7.3): a tiny local HTTP server on a thread."""
    result: dict[str, Any] = {}
    got = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            u = urlparse(self.path)
            if u.path != path:
                self.send_response(404)
                self.end_headers()
                return
            q = parse_qs(u.query)
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(success_html.encode())
            if "code" in q:
                result["code"] = q["code"][0]
                result["state"] = q.get("state", [None])[0]
            else:
                result["error"] = f"{q.get('error', ['no code in redirect'])[0]} {q.get('error_description', [''])[0]}".strip()
            got.set()

        def log_message(self, *a: Any) -> None:
            pass

    HTTPServer.allow_reuse_address = True
    server = HTTPServer((host, port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def close() -> None:
        server.shutdown()
        server.server_close()
    actual_port = server.server_address[1]

    async def default_show(url: str) -> None:
        print(f"Open this URL to authorize:\n{url}", file=sys.stderr)

    async def wait() -> tuple[str, str | None]:
        ok = await asyncio.to_thread(got.wait, timeout)
        if not ok:
            raise TimeoutError("timed out waiting for the authorization redirect")
        if "error" in result:
            raise RuntimeError(f"authorization failed: {result['error']}")
        return result["code"], result.get("state")

    return ConsentHandler(redirect_url=f"http://{host}:{actual_port}{path}", on_authorization_url=on_authorization_url or default_show, wait_for_code=wait, close=close)


def manual_consent(redirect_url: str, on_authorization_url: Callable[[str], Awaitable[None]], wait_for_code: Callable[[], Awaitable[tuple[str, str | None]]]) -> ConsentHandler:
    """For headless agents: relay the URL and the code through whatever channel exists."""
    return ConsentHandler(redirect_url=redirect_url, on_authorization_url=on_authorization_url, wait_for_code=wait_for_code)


# ---------- provider ----------


def oauth_provider(server_name: str, server_url: str, *, store: TokenStore, consent: ConsentHandler, client_name: str = "protogrid-sdk agent", scope: str | None = None, client_metadata_url: str | None = None) -> Any:
    """``mcp.client.auth.OAuthClientProvider`` (an ``httpx.Auth``) backed by ``store``, scoped to one server.

    Requires the ``mcp`` package. Pass the result as ``auth`` to the transports / ``open_session``.
    """
    from mcp.client.auth import OAuthClientProvider, TokenStorage
    from mcp.shared.auth import AuthorizationCodeResult, OAuthClientInformationFull, OAuthClientMetadata, OAuthToken

    k_tokens, k_client = f"{server_name}:tokens", f"{server_name}:client"

    class _Storage(TokenStorage):
        async def get_tokens(self) -> OAuthToken | None:
            d = store.get(k_tokens)
            return OAuthToken.model_validate(d) if d else None

        async def set_tokens(self, tokens: OAuthToken) -> None:
            store.set(k_tokens, tokens.model_dump(mode="json", exclude_none=True))

        async def get_client_info(self) -> OAuthClientInformationFull | None:
            d = store.get(k_client)
            return OAuthClientInformationFull.model_validate(d) if d else None

        async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
            store.set(k_client, client_info.model_dump(mode="json", exclude_none=True))

    async def callback() -> AuthorizationCodeResult:
        code, state = await consent.wait_for_code()
        return AuthorizationCodeResult(code=code, state=state)

    metadata = OAuthClientMetadata(
        client_name=client_name,
        redirect_uris=[consent.redirect_url],  # type: ignore[list-item]
        grant_types=["authorization_code", "refresh_token"],
        response_types=["code"],
        token_endpoint_auth_method="none",
        **({"scope": scope} if scope else {}),
    )
    kwargs: dict[str, Any] = {}
    if client_metadata_url:
        kwargs["client_metadata_url"] = client_metadata_url
    return OAuthClientProvider(server_url=server_url, client_metadata=metadata, storage=_Storage(), redirect_handler=consent.on_authorization_url, callback_handler=callback, **kwargs)
