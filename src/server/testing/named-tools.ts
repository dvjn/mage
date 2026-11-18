// Finds where a request names a tool other than as the model calls it, for tests of what the model
// reads.

import type { ModelRequest } from "@/server/models/gateway.ts";

// What the prompt and the tools' descriptions and schemas say that names a tool otherwise: any
// tool id, wherever it appears, and any dotted name the request gives a tool before providers'
// characters are applied.
export function namedOtherwise(request: Omit<ModelRequest, "model">, toolIds: readonly string[]) {
  const offered = [...(request.tools ?? []), ...(request.searchable ?? [])];
  const dotted = new Set(offered.map((tool) => tool.id).filter((name) => name.includes(".")));
  const texts = [
    request.instructions,
    ...offered.map((tool) => JSON.stringify([tool.description, tool.inputSchema])),
  ];
  const ids = toolIds.filter((id) => texts.some((text) => text.includes(id)));
  const names = texts.flatMap((text) => text.match(/[\w-]+(?:\.[\w-]+)+/g) ?? []);
  return [...new Set([...ids, ...names.filter((name) => dotted.has(name))])];
}
