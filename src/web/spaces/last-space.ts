// The space this browser was last in, in each org, so the app opens there again.

import { tabOrg } from "@/web/lib/org-tab";

function key(orgId: string | null) {
  return orgId ? `mage:last-space:${orgId}` : "mage:last-space";
}

export function rememberSpace(spaceId: string) {
  try {
    localStorage.setItem(key(tabOrg()), spaceId);
  } catch {
    // Storage can be unavailable; the app then opens the first space.
  }
}

// The space last used in the org, or in the tab's org.
export function lastSpace(orgId = tabOrg()) {
  try {
    return localStorage.getItem(key(orgId));
  } catch {
    return null;
  }
}
