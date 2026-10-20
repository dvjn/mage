import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { LoginForm } from "@/web/components/login-form";
import { SignupForm } from "@/web/components/signup-form";
import { Button } from "@/web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import { apiClient } from "@/web/lib/api-client";
import { authClient } from "@/web/lib/auth-client";

import { healthSchema } from "@/shared/health.ts";

import "./index.css";

function SignedIn({ name, onSignOut }: { name: string; onSignOut: () => void }) {
  const [status, setStatus] = useState("checking…");

  useEffect(() => {
    apiClient.health
      .$get()
      .then((res) => res.json())
      .then((body) => setStatus(healthSchema.parse(body).ok ? "ok" : "unhealthy"))
      .catch(() => setStatus("unreachable"));
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{name}</CardTitle>
        <CardDescription>Signed in to Mage</CardDescription>
      </CardHeader>
      <CardContent>
        API: <output>{status}</output>
      </CardContent>
      <CardFooter>
        <Button variant="outline" onClick={onSignOut}>
          Sign out
        </Button>
      </CardFooter>
    </Card>
  );
}

function App() {
  const { data: session, isPending } = authClient.useSession();
  const [view, setView] = useState<"login" | "signup">("login");

  function signOut() {
    setView("login");
    void authClient.signOut();
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {isPending ? null : session ? (
          <SignedIn name={session.user.name} onSignOut={signOut} />
        ) : view === "signup" ? (
          <SignupForm onSignIn={() => setView("login")} />
        ) : (
          <LoginForm onSignUp={() => setView("signup")} />
        )}
      </div>
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
