// The space this browser was last in, so the app opens there again.

const KEY = "mage:last-space";

export function rememberSpace(spaceId: string) {
  try {
    localStorage.setItem(KEY, spaceId);
  } catch {
    // Storage can be unavailable; the app then opens the first space.
  }
}

export function lastSpace() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
