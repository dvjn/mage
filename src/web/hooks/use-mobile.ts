import * as React from "react";

const MOBILE_BREAKPOINT = 768;

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

const snapshot = () => window.innerWidth < MOBILE_BREAKPOINT;

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, snapshot, () => false);
}
