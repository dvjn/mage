// What MCP resources give the agent: listed resources by server, and a read resource's contents
// with text kept as text and bytes described by type and size rather than inlined, unless they are
// small and text-like. Both are kept to a cap, so one large resource cannot fill the model's
// context.

import type { McpResource, McpResourceContent } from "./client.ts";

// The most characters of text a read gives back, across its parts.
export const RESOURCE_TEXT_MAX = 50_000;

// The most resources a listing gives back, across servers.
export const RESOURCE_LIST_MAX = 200;

// Bytes no larger than this, of a text-like type, are decoded and given back as text.
const SMALL_BLOB_BYTES = 16_000;

const TEXT_LIKE =
  /^text\/|^application\/(json|xml|yaml|x-yaml|javascript|toml|csv)$|[+](json|xml)$/;

export function textLike(mimeType: string | undefined) {
  return !!mimeType && TEXT_LIKE.test(mimeType.split(";")[0]!.trim().toLowerCase());
}

// A resource as the agent reads it in a listing, with the server it is on.
export function listed(server: string, resource: McpResource) {
  return {
    server,
    uri: resource.uri,
    name: resource.name,
    ...(resource.title && { title: resource.title }),
    ...(resource.description && { description: resource.description }),
    ...(resource.mimeType && { mimeType: resource.mimeType }),
    ...(resource.size !== undefined && { size: resource.size }),
  };
}

export type ReadPart =
  | { uri: string; mimeType?: string; text: string }
  | { uri: string; mimeType?: string; size: number; note: string };

// A read resource's parts as the agent reads them, and whether text was cut to the cap.
export function contentsOf(parts: readonly McpResourceContent[]) {
  let left = RESOURCE_TEXT_MAX;
  let cut = false as boolean;
  const contents: ReadPart[] = [];
  const keep = (text: string) => {
    if (text.length <= left) {
      left -= text.length;
      return text;
    }
    cut = true;
    const kept = text.slice(0, Math.max(0, left));
    left = 0;
    return kept;
  };
  for (const part of parts) {
    const type = part.mimeType ? { mimeType: part.mimeType } : {};
    if (part.text !== undefined) {
      contents.push({ uri: part.uri, ...type, text: keep(part.text) });
      continue;
    }
    const bytes = Buffer.from(part.blob ?? "", "base64");
    if (textLike(part.mimeType) && bytes.length <= SMALL_BLOB_BYTES) {
      contents.push({ uri: part.uri, ...type, text: keep(bytes.toString("utf8")) });
      continue;
    }
    contents.push({
      uri: part.uri,
      ...type,
      size: bytes.length,
      note: "Binary content, not shown.",
    });
  }
  return { contents, ...(cut && { cut: true }) };
}
