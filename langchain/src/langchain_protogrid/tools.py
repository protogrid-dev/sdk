"""Two tools for an agent: find MCP servers by what they do, and ask whether one passes the rules its owner set."""
from __future__ import annotations

import json
import os
from typing import Any

from langchain_core.tools import BaseTool
from protogrid import AsyncProtogridClient, ProtogridClient, ProtogridError
from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, SecretStr

from .rules import DEFAULT_RULES, Rules


class _Registry(BaseTool):
    """The connection to protogrid both tools share. ``PROTOGRID_API_KEY`` raises the limits; no key is needed."""

    model_config = ConfigDict(arbitrary_types_allowed=True)
    api_key: SecretStr | None = Field(default_factory=lambda: SecretStr(k) if (k := os.environ.get("PROTOGRID_API_KEY")) else None)
    base_url: str = Field(default_factory=lambda: os.environ.get("PROTOGRID_API_URL", "https://api.protogrid.dev"))
    _sync: ProtogridClient | None = PrivateAttr(default=None)

    def _kwargs(self) -> dict[str, Any]:
        return {"base_url": self.base_url, "api_key": self.api_key.get_secret_value() if self.api_key else None, "user_agent": "langchain-protogrid"}

    def _client(self) -> ProtogridClient:
        if self._sync is None:
            self._sync = ProtogridClient(**self._kwargs())
        return self._sync

    def _aclient(self) -> AsyncProtogridClient:
        return AsyncProtogridClient(**self._kwargs())


class SearchInput(BaseModel):
    query: str = Field(description="What the MCP server should do, in plain words, such as 'send an email' or 'query a postgres database'.")
    limit: int = Field(default=5, ge=1, le=20, description="How many servers to return.")


def _summary(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": r["name"],
        "title": r.get("title"),
        "description": (r.get("description") or "")[:300],
        "connection_class": r.get("connection_class"),
        "quality_score": r.get("quality_score"),
        "quality_flags": r.get("quality_flags", []),
        "owner_verified": r.get("owner_verified", False),
        "tools": [t["name"] for t in r.get("matched_tools", [])][:5],
    }


class ProtogridSearch(_Registry):
    """Finds MCP servers in the protogrid registry by what they do, with what decides the choice for each."""

    name: str = "protogrid_search"
    description: str = (
        "Find MCP servers by what they do. Returns for each: its registry name, connection class (R0 nothing to set up, "
        "R1 needs a key, R2 needs a sign-in, L0 a local package), quality score and flags, whether its owner is verified, "
        "and the tools that matched."
    )
    args_schema: type[BaseModel] = SearchInput

    def _run(self, query: str, limit: int = 5, **_: Any) -> str:
        try:
            res = self._client().search(query, limit=limit)
        except ProtogridError as e:
            return json.dumps({"error": e.code, "status": e.status})
        return json.dumps([_summary(r) for r in res["results"]], ensure_ascii=False)

    async def _arun(self, query: str, limit: int = 5, **_: Any) -> str:
        async with self._aclient() as c:
            try:
                res = await c.search(query, limit=limit)
            except ProtogridError as e:
                return json.dumps({"error": e.code, "status": e.status})
        return json.dumps([_summary(r) for r in res["results"]], ensure_ascii=False)


class GateInput(BaseModel):
    server: str = Field(description="The server's registry name, such as io.github.owner/server, as protogrid_search returns it.")


class ProtogridGate(_Registry):
    """Whether one MCP server passes the rules set when the tool was built. The model names the server; it cannot change
    the rules."""

    name: str = "protogrid_gate"
    description: str = "Check whether an MCP server passes the rules its owner set for this agent before using it. Returns pass or fail with every broken rule."
    args_schema: type[BaseModel] = GateInput
    rules: Rules = DEFAULT_RULES

    def _answer(self, gate: dict[str, Any]) -> str:
        return json.dumps(
            {
                "server": gate["server"],
                "pass": gate["pass"],
                "failed": [f["detail"] for f in gate["failed"]],
                "quality_score": gate["quality"]["score"],
                "connection_class": gate["class"],
                "owner_verified": gate["owner_verified"],
                "tools_hash": gate.get("tools_hash"),
            }
        )

    def _run(self, server: str, **_: Any) -> str:
        try:
            return self._answer(self._client().gate(server, **self.rules.gate_kwargs()))
        except ProtogridError as e:
            return json.dumps({"server": server, "pass": False, "failed": [f"registry answered {e.status} ({e.code})"]})

    async def _arun(self, server: str, **_: Any) -> str:
        async with self._aclient() as c:
            try:
                return self._answer(await c.gate(server, **self.rules.gate_kwargs()))
            except ProtogridError as e:
                return json.dumps({"server": server, "pass": False, "failed": [f"registry answered {e.status} ({e.code})"]})
