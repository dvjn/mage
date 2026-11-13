// Where the journeys' servers listen: Mage with passwords, the same Mage signing in only through the
// stand-in identity provider, the same Mage with its real model providers, and the mock's stand-ins:
// that identity provider, a model provider, an MCP server with its own authorization server, and a
// git host of skills repositories. The mock's e2e config gives it the same ports.

export const passwordServer = "http://localhost:4793";
export const ssoServer = "http://localhost:4796";
export const wireServer = "http://localhost:4797";
export const issuer = "http://localhost:4794";
export const modelServer = "http://localhost:4792";
export const mcpServer = "http://localhost:4791";
export const gitServer = "http://localhost:4790";
// Where the password server serves artifact pages from: an origin each, on its own port.
export const artifactOrigin = "http://*.localhost:4793";
export const artifactHost = (id: string) => artifactOrigin.replace("*", id.toLowerCase());
