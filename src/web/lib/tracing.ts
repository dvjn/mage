// Traces of what people do in the client, loaded only once the server says it traces: the actions
// worth following, with their requests, and when each run's reply first shows and when it is done.
// While tracing is off, nothing more is loaded and actions run as they are.

type Sdk = typeof import("./tracing-sdk");

let sdk: Sdk | null = null;
let loading: Promise<void> | null = null;

// Loads tracing and starts it, once, when the server says it is on.
export function startTracing(on: boolean | undefined, load: () => Promise<Sdk> = loadSdk) {
  if (!on || loading) return;
  loading = load().then(
    (loaded) => {
      loaded.start();
      sdk = loaded;
    },
    () => {
      loading = null;
    },
  );
}

function loadSdk() {
  return import("./tracing-sdk");
}

// Runs a person's action as a span, the requests it makes its children. The next run of the thread
// it names, or that `threadOf` finds in its result, answers it.
export function traced<T>(
  name: string,
  threadId: string | null,
  action: () => Promise<T>,
  threadOf?: (result: T) => string,
): Promise<T> {
  return sdk ? sdk.traced(name, threadId, action, threadOf) : action();
}

// The thread's run under way, as its live stream tells it.
export function runShown(
  threadId: string,
  run: { id: string; waiting: string | null; trace?: string } | null,
) {
  sdk?.runShown(threadId, run);
}

// A piece of the thread's reply in progress arrived to be shown.
export function pieceShown(threadId: string, part: "text" | "reasoning") {
  sdk?.pieceShown(threadId, part);
}
