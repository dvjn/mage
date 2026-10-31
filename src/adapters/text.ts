// Reading bytes as text: valid UTF-8 with no NUL byte, else not text at all.

const decoder = new TextDecoder("utf-8", { fatal: true });

// The bytes as text, or null when they are not text.
export function textOf(bytes: Uint8Array) {
  if (bytes.includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}
