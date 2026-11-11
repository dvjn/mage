// A model ref names a model through one of an org's connections: `<connection id>/<model id>`. The
// model id may hold slashes of its own, so a ref splits at the first one; a ref with none has no
// connection.

export function parseModelRef(ref: string): { connectionId: string; modelId: string } {
  const slash = ref.indexOf("/");
  if (slash < 0) return { connectionId: "", modelId: ref };
  return { connectionId: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}
