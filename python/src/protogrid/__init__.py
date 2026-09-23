"""protogrid: find MCP servers by intent, get a connection block, connect with no human in the loop."""
from .client import DEFAULT_BASE_URL, AsyncProtogridClient, ProtogridClient, ProtogridError
from .connect import Connectable, OAuthOptions, afind_connectable, find_connectable, open_session, resolve_entry, secrets_satisfied
from .formatters import to_fastmcp_transport, to_mcp_servers, to_pydantic_ai
from .oauth import ConsentHandler, FileTokenStore, MemoryTokenStore, TokenStore, has_tokens, loopback_consent, manual_consent, oauth_provider
from .secrets import MissingSecretsError, placeholders_in, substitute_secrets
from .types import META_NS, ConnectionClass, ConnectionResponse, ConnectionTarget, Descriptor, ListToolsResponse, SearchResponse, SearchResult, TrustFlag

__all__ = [
    "DEFAULT_BASE_URL", "AsyncProtogridClient", "ProtogridClient", "ProtogridError",
    "Connectable", "OAuthOptions", "afind_connectable", "find_connectable", "open_session", "resolve_entry", "secrets_satisfied",
    "to_fastmcp_transport", "to_mcp_servers", "to_pydantic_ai",
    "ConsentHandler", "FileTokenStore", "MemoryTokenStore", "TokenStore", "has_tokens", "loopback_consent", "manual_consent", "oauth_provider",
    "MissingSecretsError", "placeholders_in", "substitute_secrets",
    "META_NS", "ConnectionClass", "ConnectionResponse", "ConnectionTarget", "Descriptor", "ListToolsResponse", "SearchResponse", "SearchResult", "TrustFlag",
]
__version__ = "0.2.0"
