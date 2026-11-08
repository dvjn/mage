// The org this tab acts in. Each tab keeps its own, so two tabs can work in two orgs side by side;
// every API call names it. A page of a space or thread in another of the person's orgs moves the
// tab to that org, and switching orgs reloads the tab there, so nothing of the last org lingers. A
// tab whose person is no longer in its org starts again in the org they used last.

import { ORG_NOT_FOUND } from "@/shared/orgs.ts";

const KEY = "mage:tab-org";

let current: string | null = read();

function read() {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function write(orgId: string) {
  current = orgId;
  try {
    sessionStorage.setItem(KEY, orgId);
  } catch {
    // Storage can be unavailable; the tab then keeps the org until it reloads.
  }
}

// The tab's org, or null before it is known; requests then act in the org used last.
export function tabOrg() {
  return current;
}

// Takes the org the server chose when the tab had none.
export function adoptOrg(orgId: string) {
  if (!current) write(orgId);
}

// Fetches as the API client does, naming the tab's org unless the request names one, and leaving
// the tab's org when the person is no longer in it.
export async function orgFetch(input: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(orgHeaders())) {
    if (!headers.has(name)) headers.set(name, value);
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status === 404 && current) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { error?: string } | null;
    if (body?.error === ORG_NOT_FOUND) {
      current = null;
      try {
        sessionStorage.removeItem(KEY);
      } catch {
        // Nothing kept.
      }
      window.location.assign("/");
    }
  }
  return res;
}

// The headers that name the tab's org.
export function orgHeaders(): Record<string, string> {
  return current ? { "X-Mage-Org": current } : {};
}

// Moves the tab to the org and opens the path there, reloading the app.
export function switchOrg(orgId: string, path = "/") {
  write(orgId);
  window.location.assign(path);
}

// Which of the person's orgs the space or thread is in, or null when it is in none of them.
export async function locate(place: { space: string } | { thread: string }) {
  const query = "space" in place ? `space=${place.space}` : `thread=${place.thread}`;
  const res = await fetch(`/api/v1/locate?${query}`, { headers: orgHeaders() }).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json()) as { orgId?: string };
  return body.orgId ?? null;
}

// The space or thread the path opens, if any.
function placeOf(pathname: string) {
  const match = /^\/(s|t)\/([^/]+)/.exec(pathname);
  if (!match) return null;
  return match[1] === "s" ? { space: match[2]! } : { thread: match[2]! };
}

// Before the app starts: a tab without an org that opens a space or thread takes that one's org.
export async function startTab() {
  if (current) return;
  const place = placeOf(window.location.pathname);
  const orgId = place && (await locate(place));
  if (orgId) write(orgId);
}

// When a space or thread is in another of the person's orgs, moves the tab there to open `path`,
// and says so.
export async function followPlace(place: { space: string } | { thread: string }, path: string) {
  const orgId = await locate(place);
  if (!orgId || orgId === current) return false;
  switchOrg(orgId, path);
  return true;
}
