# Model Context Protocol (MCP) Usage Policy

## MCP Safety & Security Rules
1. **Never Invent MCP Servers**: Only use MCP capabilities verified in the active environment.
2. **Never Commit Credentials**: Configuration files must use environment variable placeholders (`${ENV_VAR}`).
3. **No Machine-Specific Private Paths**: Committed templates (`mcp.example.json`) must contain portable relative path placeholders.
4. **Fallback Requirement**: Every optional MCP must document a native fallback path (e.g. file search if Codebase Memory MCP is unavailable).
5. **No Automatic System Mutation**: Do not modify global user MCP configuration files without explicit user approval.
