// Passes the web client's spans, sent as OTLP over HTTP, on to the collector, so the collector is
// never exposed to browsers.

const OTLP_TYPES = ["application/json", "application/x-protobuf"];

export type TraceRelay = (request: Request) => Promise<Response>;

export function createTraceRelay(options: {
  url: string;
  headers: Record<string, string>;
  fetch?: typeof fetch;
}): TraceRelay {
  const fetchFn = options.fetch ?? fetch;
  return async (request) => {
    const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!OTLP_TYPES.includes(type)) {
      return Response.json({ error: "Send OTLP as JSON or protobuf" }, { status: 415 });
    }
    try {
      const res = await fetchFn(options.url, {
        method: "POST",
        headers: { ...options.headers, "content-type": type },
        body: await request.arrayBuffer(),
      });
      return new Response(res.body, {
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") ?? type },
      });
    } catch {
      return Response.json({ error: "The collector did not answer" }, { status: 502 });
    }
  };
}
