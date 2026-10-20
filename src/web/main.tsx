import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [status, setStatus] = useState("checking…");

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json() as Promise<{ ok: boolean }>)
      .then((body) => setStatus(body.ok ? "ok" : "unhealthy"))
      .catch(() => setStatus("unreachable"));
  }, []);

  return (
    <main>
      <h1>Mage</h1>
      <p>
        API: <output>{status}</output>
      </p>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
