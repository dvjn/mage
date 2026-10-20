import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
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
import { authClient } from "@/web/lib/auth-client";
import { healthQuery, sessionQuery } from "@/web/lib/queries";

import "./index.css";

function SignedIn({ name, onSignOut }: { name: string; onSignOut: () => void }) {
  const health = useQuery(healthQuery);
  const status = health.isPending
    ? "checking…"
    : health.isError
      ? "unreachable"
      : health.data.ok
        ? "ok"
        : "unhealthy";

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
  const queryClient = useQueryClient();
  const { data: session, isPending } = useQuery(sessionQuery);
  const [view, setView] = useState<"login" | "signup">("login");

  async function signOut() {
    setView("login");
    await authClient.signOut();
    await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {isPending ? null : session ? (
          <SignedIn name={session.user.name} onSignOut={() => void signOut()} />
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
const queryClient = new QueryClient();
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
