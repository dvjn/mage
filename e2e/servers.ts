// Where the journeys' servers listen: Mage with passwords, the same Mage signing in only through the
// stand-in identity provider, that provider, a stand-in OpenAI-compatible server, and a stand-in
// MCP server with its own authorization server.

export const passwordServer = "http://localhost:4793";
export const ssoServer = "http://localhost:4796";
export const issuer = "http://localhost:4794";
export const modelServer = "http://localhost:4792";
export const mcpServer = "http://localhost:4791";
