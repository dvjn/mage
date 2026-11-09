// Where artifacts are served from: one origin for all of them, or with `*` as its leftmost label an
// origin of their own each, so no page shares storage or cookies with another.

export function isOriginPattern(origin: string) {
  return /^https?:\/\/\*\./.test(origin);
}

// The origin an artifact is served from; hostnames are case-insensitive, so its id is lower-cased.
export function originOf(origin: string, id: string) {
  return isOriginPattern(origin) ? origin.replace("*", id.toLowerCase()) : origin;
}

// The artifact a host names under a wildcard origin, or null for any other host.
export function artifactOfHost(origin: string, host: string) {
  if (!isOriginPattern(origin)) return null;
  const own = origin.slice(origin.indexOf("*") + 1);
  const lower = host.toLowerCase();
  const label = lower.endsWith(own) ? lower.slice(0, -own.length) : "";
  return label.length > 0 && !label.includes(".") ? label : null;
}

// Whether a host is one artifacts are served from.
export function isArtifactHost(origin: string, host: string) {
  if (isOriginPattern(origin)) return artifactOfHost(origin, host) !== null;
  return host.toLowerCase() === new URL(origin).host;
}
