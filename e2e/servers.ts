// Where the journeys' servers listen: Mage with passwords, the same Mage signing in only through the
// stand-in identity provider, the same Mage with its real model providers, and the mock's stand-ins:
// that identity provider, a model provider, an MCP server with its own authorization server, and a
// git host of skills repositories. The mock's e2e config gives it the same ports. Also how Mage is
// run for them, and where a journey that runs servers of its own puts them.

// Where the journeys' Postgres listens, and the databases in it: one the password and identity
// provider servers share, one of its own for the server with real model providers, whose worker
// would otherwise take the others' runs and fail them for want of a model, and one for the servers
// a journey runs and kills itself, whose runs no other server may take.
export const databasePort = 4795;
const databaseUrl = (name: string) => `postgres://mage:mage@localhost:${databasePort}/${name}`;
export const databases = {
  mage: databaseUrl("mage"),
  mage_wire: databaseUrl("mage_wire"),
  mage_instances: databaseUrl("mage_instances"),
};

// What every Mage the journeys run is given, beside where it listens.
export const serverEnv = {
  NODE_ENV: "test",
  MODEL_GATEWAY: "fake",
  AUTH_SECRET: "mage-browser-journeys-secret-0123456789",
  CREDENTIAL_KEY: "WFnQPvVJ7j8limmjR6tFVpYWlTRqy8Rf8i6UJnaIaQg=",
  DATABASE_URL: databases.mage,
};

export const passwordServer = "http://localhost:4793";
export const ssoServer = "http://localhost:4796";
export const wireServer = "http://localhost:4797";
export const issuer = "http://localhost:4794";
export const modelServer = "http://localhost:4792";
export const mcpServer = "http://localhost:4791";
export const gitServer = "http://localhost:4790";
// Two instances of the built server on one database of their own, which a journey starts and
// kills itself.
export const instanceServers = ["http://localhost:4788", "http://localhost:4789"] as const;
// Where the password server serves artifact pages from: an origin each, on its own port.
export const artifactOrigin = "http://*.localhost:4793";
export const artifactHost = (id: string) => artifactOrigin.replace("*", id.toLowerCase());
