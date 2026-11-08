import { describe, expect, it } from "vite-plus/test";

import { recordedHeaders, requestHeaderPairs, responseHeaderPairs } from "./tracing.ts";

const credentials = {
  authorization: "Bearer secret",
  "x-api-key": "sk-ant-secret",
  "x-aegis-api-key": "aegis-secret",
  cookie: "session=secret",
  "set-cookie": "session=secret",
  "chatgpt-account-id": "account",
};

describe("recorded headers", () => {
  it("keep the provider headers that explain a request, and never a credential", () => {
    const request = recordedHeaders(
      "request",
      Object.entries({
        ...credentials,
        "Anthropic-Beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-cli/2.0",
        "x-app": "cli",
        "content-type": "application/json",
      }),
    );
    expect(request).toEqual({
      "http.request.header.anthropic-beta": ["oauth-2025-04-20"],
      "http.request.header.anthropic-version": ["2023-06-01"],
      "http.request.header.user-agent": ["claude-cli/2.0"],
      "http.request.header.x-app": ["cli"],
    });
  });

  it("keep the request ids, rate limits and processing time a provider answers with", () => {
    const response = recordedHeaders(
      "response",
      Object.entries({
        ...credentials,
        "request-id": "req_1",
        "x-request-id": "req_2",
        "anthropic-ratelimit-tokens-remaining": "1000",
        "x-ratelimit-remaining-requests": "99",
        "openai-processing-ms": "120",
        "openai-organization": "org-name",
        "anthropic-version": "2023-06-01",
      }),
    );
    expect(response).toEqual({
      "http.response.header.request-id": ["req_1"],
      "http.response.header.x-request-id": ["req_2"],
      "http.response.header.anthropic-ratelimit-tokens-remaining": ["1000"],
      "http.response.header.x-ratelimit-remaining-requests": ["99"],
      "http.response.header.openai-processing-ms": ["120"],
    });
  });

  it("read the fetch client's raw headers in each form it gives them", () => {
    expect(requestHeaderPairs("x-api-key: secret\r\nx-app: cli\r\n")).toEqual([
      ["x-api-key", "secret"],
      ["x-app", "cli"],
    ]);
    expect(requestHeaderPairs(["anthropic-beta", ["a", "b"], "x-app", "cli"])).toEqual([
      ["anthropic-beta", "a"],
      ["anthropic-beta", "b"],
      ["x-app", "cli"],
    ]);
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(responseHeaderPairs([bytes("request-id"), bytes("req_1")])).toEqual([
      ["request-id", "req_1"],
    ]);
  });
});
