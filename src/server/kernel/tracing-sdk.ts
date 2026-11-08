// Starts tracing: the OpenTelemetry SDK, configured by the standard OTEL_* variables, exporting
// over OTLP; spans of outgoing fetches, recording only the provider headers allowed; and the AI
// SDK's spans of each model call, with its token use, cache reads and writes, and what the
// provider reported.

import { OpenTelemetry } from "@ai-sdk/otel";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { registerTelemetry } from "ai";

import type { Tracing } from "./config.ts";
import {
  recordContent,
  recordedHeaders,
  requestHeaderPairs,
  responseHeaderPairs,
} from "./tracing.ts";

// The development server evaluates the entry point again after each change; tracing starts once.
const shared = globalThis as { tracingStarted?: NodeSDK };

export function startTracing(tracing: Tracing) {
  recordContent(tracing.content);
  if (shared.tracingStarted) return shared.tracingStarted;
  // The browser's spans are passed on to the collector; that request is not traced itself.
  const collector = new URL(tracing.tracesUrl).origin;
  const sdk = new NodeSDK({
    serviceName: tracing.serviceName,
    instrumentations: [
      new UndiciInstrumentation({
        // Only fetches made for traced work: replies, tool calls and requests.
        requireParentforSpans: true,
        ignoreRequestHook: (request) => request.origin === collector,
        requestHook: (span, request) => {
          span.setAttributes(recordedHeaders("request", requestHeaderPairs(request.headers)));
        },
        responseHook: (span, { response }) => {
          span.setAttributes(recordedHeaders("response", responseHeaderPairs(response.headers)));
        },
      }),
    ],
  });
  sdk.start();
  registerTelemetry(new OpenTelemetry({ usage: true, providerMetadata: true }));
  shared.tracingStarted = sdk;
  return sdk;
}
