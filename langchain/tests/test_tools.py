"""ProtogridSearch and ProtogridGate: LangChain's standard tool tests, and what they answer, on a scripted registry."""
from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from langchain_tests.unit_tests import ToolsUnitTests
from protogrid import AsyncProtogridClient, ProtogridClient

from langchain_protogrid import ProtogridGate, ProtogridSearch, Rules, tool_hash, tool_set_hash

SEEN: list[httpx.Request] = []


def registry(request: httpx.Request) -> httpx.Response:
    SEEN.append(request)
    if request.url.path == "/v1/search":
        return httpx.Response(200, json={"results": [{"name": "io.github.acme/mail", "title": "Mail", "description": "Send mail. " * 50, "connection_class": "R1", "quality_score": 88, "quality_flags": [], "owner_verified": True, "matched_tools": [{"name": "send"}]}]})
    if request.url.path.endswith("/gate"):
        return httpx.Response(200, json={"server": "io.github.acme/mail", "pass": False, "failed": [{"rule": "min_quality", "detail": "quality 88 is under 90"}], "quality": {"score": 88}, "class": "R1", "owner_verified": True, "tools_hash": "abc"})
    return httpx.Response(404, json={"error": "not_found"})


class Scripted:
    def _client(self) -> ProtogridClient:
        return ProtogridClient(transport=httpx.MockTransport(registry))

    def _aclient(self) -> AsyncProtogridClient:
        async def handler(request: httpx.Request) -> httpx.Response:
            return registry(request)

        return AsyncProtogridClient(transport=httpx.MockTransport(handler))


class ScriptedSearch(Scripted, ProtogridSearch):
    pass


class ScriptedGate(Scripted, ProtogridGate):
    pass


class TestSearchStandard(ToolsUnitTests):
    @property
    def tool_constructor(self) -> type[ProtogridSearch]:
        return ProtogridSearch

    @property
    def tool_constructor_params(self) -> dict[str, Any]:
        return {}

    @property
    def tool_invoke_params_example(self) -> dict[str, Any]:
        return {"query": "send an email", "limit": 3}

    @property
    def init_from_env_params(self) -> tuple[dict[str, str], dict[str, Any], dict[str, Any]]:
        return {"PROTOGRID_API_KEY": "pgk_test", "PROTOGRID_API_URL": "http://localhost:8080"}, {}, {"api_key": "pgk_test", "base_url": "http://localhost:8080"}


class TestGateStandard(ToolsUnitTests):
    @property
    def tool_constructor(self) -> type[ProtogridGate]:
        return ProtogridGate

    @property
    def tool_constructor_params(self) -> dict[str, Any]:
        return {"rules": Rules(min_quality=90)}

    @property
    def tool_invoke_params_example(self) -> dict[str, Any]:
        return {"server": "io.github.acme/mail"}


async def test_search_returns_what_decides_the_choice():
    out = json.loads(await ScriptedSearch().ainvoke({"query": "send mail"}))
    assert out == [{"name": "io.github.acme/mail", "title": "Mail", "description": ("Send mail. " * 50)[:300], "connection_class": "R1", "quality_score": 88, "quality_flags": [], "owner_verified": True, "tools": ["send"]}]
    assert json.loads(ScriptedSearch().invoke({"query": "send mail"}))[0]["name"] == "io.github.acme/mail"


async def test_gate_applies_the_owner_rules_whatever_the_model_asks():
    SEEN.clear()
    tool = ScriptedGate(rules=Rules(min_quality=90, owner_verified=True))
    out = json.loads(await tool.ainvoke({"server": "io.github.acme/mail", "min_quality": 0}))
    assert out["pass"] is False and out["failed"] == ["quality 88 is under 90"]
    q = SEEN[-1].url.params
    assert q["min_quality"] == "90" and q["owner_verified"] == "true"
    assert q["no_fail"] == "tools.hidden_text,tools.poisoning" and q["exclude_quality_flags"] == "known-vulns" and q["class"] == "R0,R1"


def test_tool_hashes_match_the_registry():
    # Computed with the registry's own toolHash and toolSetHash on 2026-11-23.
    tools = [
        {"name": "send_mail", "title": "Send mail", "description": "Envía un correo · ✉️ \"quoted\"\nline", "inputSchema": {"type": "object", "properties": {"to": {"type": "string"}, "n": {"type": "number", "default": 1.0, "maximum": 2.5}}, "required": ["to"]}, "annotations": {"readOnlyHint": False, "destructiveHint": True}},
        {"name": "ping", "inputSchema": {"type": "object"}},
        {"name": "nested", "description": "", "inputSchema": {"b": [1, 2, {"z": None, "a": True}], "a": "x"}, "outputSchema": {"type": "object"}},
    ]
    assert [tool_hash(t) for t in tools] == ["05731c7493785f9617c2d89f8c78855a", "368ac32a74c771aeceef04b341a2e6a1", "b307a967b26050498731eacbf7544c20"]
    assert tool_set_hash(tools) == "b23aae45d640ee5ab2730ce08a616530"
    assert tool_set_hash([]) is None
