import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";

import "./index.css";

function App() {
  const [status, setStatus] = useState("checking…");

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json() as Promise<{ ok: boolean }>)
      .then((body) => setStatus(body.ok ? "ok" : "unhealthy"))
      .catch(() => setStatus("unreachable"));
  }, []);

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Mage</CardTitle>
          <CardDescription>Server status</CardDescription>
        </CardHeader>
        <CardContent>
          API: <output>{status}</output>
        </CardContent>
      </Card>
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
