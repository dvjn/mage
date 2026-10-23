// Whether ⌘ or Ctrl alone has been held for a moment, as when someone looks for the shortcuts; it
// stops being held when it is let go, another key is pressed or the window loses focus.

import { useEffect, useState } from "react";

const HOLD_MS = 400;

export function useModHeld() {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    function release() {
      clearTimeout(timer);
      timer = undefined;
      setHeld(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Meta" || event.key === "Control") {
        if (!timer && !event.repeat) timer = setTimeout(() => setHeld(true), HOLD_MS);
        return;
      }
      release();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", release);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", release);
    };
  }, []);
  return held;
}
