"""Wire types of the protogrid REST API (TypedDicts: zero-copy over the JSON).

Hand-written to match the platform's descriptor contract; the SDK carries no server-specific
knowledge (design rule: SDKs are server-agnostic).
"""
from __future__ import annotations

from typing import Any, Literal, TypedDict

ConnectionClass = Literal["R0", "R1", "R2", "L0", "unknown"]
AuthType = Literal["none", "api_key", "oauth2", "unknown"]
ConnectionTarget = Literal["mcpServers", "vscode", "cursor", "claude-code-cli", "codex-toml", "gemini", "goose"]
TrustFlag = Literal["multi-version-spam", "duplicate-repo", "no-repository", "no-connection", "deprecated", "unreachable", "blocked", "deleted"]

#: Reverse-DNS namespace of protogrid.dev under ``_meta``.
META_NS = "dev.protogrid"


class NextAction(TypedDict, total=False):
    action: str
    description: str
    href: str
    arguments: dict[str, Any]


class MatchedTool(TypedDict):
    name: str
    description: str


class SearchResult(TypedDict):
    name: str
    title: str | None
    description: str
    connection_class: ConnectionClass
    autonomous: bool
    human_steps: list[str]
    categories: list[str]
    trust_score: int | None
    trust_flags: list[str]
    tool_count: int
    score: float
    matched_tools: list[MatchedTool]


class SearchResponse(TypedDict):
    query: str
    mode: str
    count: int
    results: list[SearchResult]
    next_actions: list[NextAction]


class SecretRef(TypedDict):
    name: str
    where: str


class RemoteEntry(TypedDict, total=False):
    type: Literal["http", "sse"]
    url: str
    headers: dict[str, str]


class PackageEntry(TypedDict, total=False):
    command: str
    args: list[str]
    env: dict[str, str]


McpServersEntry = RemoteEntry | PackageEntry


class ConnectionResponse(TypedDict, total=False):
    server: str
    key: str
    kind: Literal["remote", "package", "bundle"]
    class_: ConnectionClass  # JSON key is "class"; use conn["class"]
    autonomous: bool
    human_steps: list[str]
    target: ConnectionTarget
    content_type: str
    connection: Any
    secrets: list[SecretRef]
    auth_type: AuthType
    oauth: dict[str, Any]
    placeholders: str
    next_actions: list[NextAction]


class ToolEntry(TypedDict, total=False):
    name: str
    title: str | None
    description: str
    input_schema: Any
    output_schema: Any
    annotations: Any
    source: str
    observed_at: str


class ListToolsResponse(TypedDict):
    server: str
    count: int
    tools: list[ToolEntry]
    next_cursor: str | None
    next_actions: list[NextAction]


Descriptor = dict[str, Any]
"""``{"server": <official server.json>, "_meta": {...}, "next_actions": [...]}``."""
