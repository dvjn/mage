// Whether the device can hover, as a mouse can and a finger cannot.

import { useEffect, useState } from "react";

const QUERY = "(hover: hover) and (pointer: fine)";

export function useCanHover() {
  const [can, setCan] = useState(() => window.matchMedia(QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(QUERY);
    const onChange = () => setCan(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return can;
}
