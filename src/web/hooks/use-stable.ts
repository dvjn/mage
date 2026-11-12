// A function with one identity for as long as its component lives, which always calls the latest
// `fn`, so a memoised child that takes it as a prop is not rendered again when `fn` is.

import { useCallback, useLayoutEffect, useRef } from "react";

export function useStable<Args extends unknown[], Result>(fn: (...args: Args) => Result) {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
