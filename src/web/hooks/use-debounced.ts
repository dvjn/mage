// A value that follows another once it has stopped changing for a while, as typed text does.

import { useEffect, useState } from "react";

export function useDebounced<T>(value: T, ms = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
