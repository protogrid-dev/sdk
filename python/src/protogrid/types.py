"""Wire types of the protogrid REST API (TypedDicts: zero-copy over the JSON).

Hand-written to match the platform's descriptor contract; the SDK carries no server-specific
knowledge (design rule: SDKs are server-agnostic).
"""
from __future__ import annotations

from typing import Any, Literal, TypedDict

ConnectionClass = Literal["R0", "R1", "R2", "L0", "unknown"]
AuthType = Literal["none", "api_key", "oauth2", "unknown"]
ConnectionTarget = Literal["mcpServers", "vscode", "cursor", "claude-code-cli", "codex-toml", "opencode", "gemini", "goose"]
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


class _SearchResultOptional(TypedDict, total=False):
    # Present from registries that compute quality (protogrid, 2026-09-24 on).
    quality_score: int | None
    quality_label: str  # strong, good, needs work, poor, new, not scored


class SearchResult(_SearchResultOptional):
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


# --- On-demand checks (POST /v1/check): one credential-free probe of a remote MCP server URL ---

CheckStatus = Literal["queued", "running", "done", "failed"]
ReadinessStatus = Literal["pass", "warn", "fail", "na", "unknown", "manual"]


class ReadinessItem(TypedDict):
    id: str
    directory: Literal["claude", "openai"]
    title: str
    level: Literal["must", "should"]
    #: ``heuristic`` items only ask for a review; ``manual`` ones nobody can see from outside.
    kind: Literal["auto", "heuristic", "manual"]
    #: The directory documentation page the requirement comes from.
    source: str
    status: ReadinessStatus
    detail: str


class DirectoryReadiness(TypedDict):
    directory: Literal["claude", "openai"]
    name: str
    checked_on: str
    docs: str
    items: list[ReadinessItem]
    summary: dict[str, int]


class CheckResult(TypedDict):
    checked_at: str
    url: str
    #: Catalog server whose remote has this URL.
    server: str | None
    #: outcome, protocol, a summary of the OAuth metadata, the tools without schemas, redirects.
    probe: dict[str, Any]
    #: score, label (good, needs work, poor, not scored), components, checks, drivers.
    quality: dict[str, Any]
    readiness: list[DirectoryReadiness]


class _CheckResponseOptional(TypedDict, total=False):
    #: Present once ``status`` is ``done``.
    result: CheckResult
    error: str


class CheckResponse(_CheckResponseOptional):
    id: str
    status: CheckStatus
    url: str
    requested_at: str
    finished_at: str | None
    server: str | None
    #: Shareable result page on the portal.
    page: str
    disclaimer: str
    next_actions: list[NextAction]
