// The one place that reads process.env. Services receive this object.

export interface Config {
  baseUrl: string;
  port: number;
  webRoot: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? "4783");
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer");
  }
  const baseUrl = env.BASE_URL ?? "";
  if (!["http:", "https:"].includes(URL.parse(baseUrl)?.protocol ?? "")) {
    throw new Error("BASE_URL is required and must be an http(s) URL");
  }
  return {
    baseUrl,
    port,
    webRoot: env.WEB_ROOT ?? "dist/web",
  };
}
