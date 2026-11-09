// The one place that reads process.env.

export interface Config {
  baseUrl: string;
  authSecret: string;
  authTrustedOrigins: string[];
  // AES-256 key sealing stored credentials.
  credentialKey: Buffer;
  databasePath: string;
  logFormat: "json" | "pretty";
  port: number;
  // Where artifact pages are served from, apart from the app's origin, with `*` as its leftmost
  // label for an origin per artifact, and the port an optional second listener answers them on;
  // null origin means pages cannot be viewed.
  artifactOrigin: string | null;
  artifactPort: number | null;
  webRoot: string;
  // Replies come from a stand-in model instead of providers; only for the browser journeys.
  fakeModels: boolean;
  // Who may create team orgs: every account, or only the operators.
  teamOrgs: "everyone" | "operator";
  // The accounts that run this server, by lower-cased email.
  operatorEmails: string[];
  // The OpenID Connect provider people sign in with, and the name its button shows. With one, it is
  // the only way in; without one, people sign in and up with a password.
  oidc: Oidc | null;
  // The bearer token a SCIM directory provisions people and groups with; none turns SCIM off.
  scimToken: string | null;
  // Where traces go, from the standard OpenTelemetry variables; null turns tracing off.
  tracing: Tracing | null;
}

export interface Tracing {
  serviceName: string;
  // Where the browser's spans are passed on to, and the headers that go with them.
  tracesUrl: string;
  headers: Record<string, string>;
  // Whether model calls record their whole prompts and replies, and tool calls their input and
  // output.
  content: boolean;
}

export interface Oidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  name: string;
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
  const artifactOrigin = env.ARTIFACT_ORIGIN
    ? (URL.parse(env.ARTIFACT_ORIGIN)?.origin ?? "")
    : null;
  if (
    artifactOrigin !== null &&
    !["http:", "https:"].includes(URL.parse(artifactOrigin)?.protocol ?? "")
  ) {
    throw new Error("ARTIFACT_ORIGIN must be an http(s) URL");
  }
  if (artifactOrigin !== null && artifactOrigin.includes("*")) {
    if (!/^https?:\/\/\*\.[^*]+$/.test(artifactOrigin)) {
      throw new Error("ARTIFACT_ORIGIN may have * only as its whole leftmost label");
    }
  }
  const appHost = URL.parse(env.BASE_URL ?? "")?.host ?? "";
  const artifactHost = artifactOrigin === null ? "" : artifactOrigin.replace(/^https?:\/\//, "");
  const coversApp = artifactHost.startsWith("*.") && appHost.endsWith(artifactHost.slice(1));
  if (artifactOrigin !== null && (artifactHost === appHost || coversApp)) {
    throw new Error("ARTIFACT_ORIGIN must differ from BASE_URL");
  }
  const artifactPort = env.ARTIFACT_PORT ? Number(env.ARTIFACT_PORT) : null;
  if (artifactPort !== null && (!Number.isInteger(artifactPort) || artifactPort <= 0)) {
    throw new Error("ARTIFACT_PORT must be a positive integer");
  }
  if (artifactPort !== null && artifactPort === port) {
    throw new Error("ARTIFACT_PORT must differ from PORT");
  }
  const logFormat = env.LOG_FORMAT ?? "json";
  if (logFormat !== "json" && logFormat !== "pretty") {
    throw new Error("LOG_FORMAT must be json or pretty");
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
  const gateway = env.MODEL_GATEWAY ?? "providers";
  if (gateway !== "providers" && gateway !== "fake") {
    throw new Error("MODEL_GATEWAY must be providers or fake");
  }
  if (env.NODE_ENV === "production" && gateway === "fake") {
    throw new Error("MODEL_GATEWAY=fake is not allowed in production");
  }
  const teamOrgs = env.TEAM_ORGS ?? "everyone";
  if (teamOrgs !== "everyone" && teamOrgs !== "operator") {
    throw new Error("TEAM_ORGS must be everyone or operator");
  }
  const operatorEmails = (env.OPERATOR_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const oidcVars = [env.OIDC_ISSUER, env.OIDC_CLIENT_ID, env.OIDC_CLIENT_SECRET];
  if (oidcVars.some(Boolean) && !oidcVars.every(Boolean)) {
    throw new Error(
      "OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are set together or not at all",
    );
  }
  const [issuer = "", clientId = "", clientSecret = ""] = oidcVars;
  if (issuer && !["http:", "https:"].includes(URL.parse(issuer)?.protocol ?? "")) {
    throw new Error("OIDC_ISSUER must be an http(s) URL");
  }
  const oidc = issuer ? { issuer, clientId, clientSecret, name: env.OIDC_NAME || "SSO" } : null;
  const scimToken = env.SCIM_TOKEN || null;
  if (scimToken && (scimToken.length < 32 || /\s/.test(scimToken))) {
    throw new Error("SCIM_TOKEN must be at least 32 characters with no spaces");
  }
  return {
    baseUrl,
    tracing: tracingOf(env),
    authSecret,
    authTrustedOrigins,
    credentialKey,
    databasePath: env.DATABASE_PATH ?? "data/mage.db",
    logFormat,
    port,
    artifactOrigin,
    artifactPort,
    webRoot: env.WEB_ROOT ?? "dist/web",
    fakeModels: gateway === "fake",
    teamOrgs,
    operatorEmails,
    oidc,
    scimToken,
  };
}

// The OTLP headers variable: comma-separated `name=value` pairs, each part URL-encoded.
function otlpHeaders(value: string | undefined) {
  const headers: Record<string, string> = {};
  for (const pair of (value ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    headers[decodeURIComponent(pair.slice(0, at).trim())] = decodeURIComponent(
      pair.slice(at + 1).trim(),
    );
  }
  return headers;
}

function tracingOf(env: NodeJS.ProcessEnv): Tracing | null {
  const content = env.TRACE_CONTENT ?? "false";
  if (content !== "true" && content !== "false") {
    throw new Error("TRACE_CONTENT must be true or false");
  }
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || env.OTEL_SDK_DISABLED === "true") return null;
  if (!["http:", "https:"].includes(URL.parse(endpoint)?.protocol ?? "")) {
    throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL");
  }
  return {
    serviceName: env.OTEL_SERVICE_NAME || "mage",
    tracesUrl:
      env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || `${endpoint.replace(/\/+$/, "")}/v1/traces`,
    headers: otlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    content: content === "true",
  };
}
