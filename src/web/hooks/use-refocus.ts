// A control that is replaced as it is focused, which takes focus back once its replacement is in.

import { useCallback, useLayoutEffect, useRef, type Ref } from "react";

// Hands the control's replacement a ref, and focuses it when `refocus` turns on. `own` is a ref the
// control already had, which is kept.
export function useRefocus(refocus: boolean, own?: Ref<HTMLElement>) {
  const node = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (refocus) node.current?.focus({ preventScroll: true });
  }, [refocus]);
  return useCallback(
    (element: HTMLElement | null) => {
      node.current = element;
      return setRef(own, element);
    },
    [own],
  );
}

function setRef(ref: Ref<HTMLElement> | undefined, element: HTMLElement | null) {
  if (typeof ref === "function") return ref(element);
  if (ref) Object.assign(ref, { current: element });
}
