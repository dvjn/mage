// The one place that reads process.env. Services receive this object.

export interface Config {
  baseUrl: string;
  authSecret: string;
  authTrustedOrigins: string[];
  // AES-256 key sealing stored credentials.
  credentialKey: Buffer;
  databasePath: string;
  port: number;
  webRoot: string;
}

// The local development secret; refused in production.
const DEVELOPMENT_AUTH_SECRET = "mage-development-secret-do-not-use-in-production";

// The local development credential key; refused in production.
const DEVELOPMENT_CREDENTIAL_KEY = Buffer.from("mage-development-only-credential");

// Read by the auth library itself with no option to override them; the rest it reads are pinned.
const UNPINNABLE_AUTH_VARS = ["BETTER_AUTH_TRUSTED_ORIGINS", "BETTER_AUTH_TELEMETRY"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const libraryVars = UNPINNABLE_AUTH_VARS.filter((name) => env[name] !== undefined);
  if (libraryVars.length > 0) {
    throw new Error(`Unsupported environment variables: ${libraryVars.join(", ")}`);
  }
  const port = Number(env.PORT ?? "4783");
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer");
  }
  const baseUrl = env.BASE_URL ?? "";
  if (!["http:", "https:"].includes(URL.parse(baseUrl)?.protocol ?? "")) {
    throw new Error("BASE_URL is required and must be an http(s) URL");
  }
  const authSecret = env.AUTH_SECRET ?? "";
  if (authSecret.length < 32) {
    throw new Error("AUTH_SECRET is required and must be at least 32 characters");
  }
  if (env.NODE_ENV === "production" && authSecret === DEVELOPMENT_AUTH_SECRET) {
    throw new Error("AUTH_SECRET must not be the development secret in production");
  }
  const credentialKey = Buffer.from(env.CREDENTIAL_KEY ?? "", "base64");
  if (credentialKey.length !== 32) {
    throw new Error("CREDENTIAL_KEY is required and must be 32 bytes in base64");
  }
  if (env.NODE_ENV === "production" && credentialKey.equals(DEVELOPMENT_CREDENTIAL_KEY)) {
    throw new Error("CREDENTIAL_KEY must not be the development key in production");
  }
  const authTrustedOrigins = (env.AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const url = URL.parse(value);
      if (!url || !["http:", "https:"].includes(url.protocol)) {
        throw new Error("AUTH_TRUSTED_ORIGINS must be a comma-separated list of http(s) URLs");
      }
      return url.origin;
    });
  return {
    baseUrl,
    authSecret,
    authTrustedOrigins,
    credentialKey,
    databasePath: env.DATABASE_PATH ?? "data/mage.db",
    port,
    webRoot: env.WEB_ROOT ?? "dist/web",
  };
}
