import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";

import { Button } from "@/web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import { Wordmark } from "@/web/components/wordmark";
import { authClient } from "@/web/lib/auth-client";
import { healthQuery, sessionQuery } from "@/web/lib/queries";

const homeRoute = getRouteApi("/");

export function Home() {
  const { session } = homeRoute.useRouteContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const health = useQuery(healthQuery);
  const status = health.isPending
    ? "checking…"
    : health.isError
      ? "unreachable"
      : health.data.ok
        ? "ok"
        : "unhealthy";

  async function signOut() {
    await authClient.signOut();
    await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    await navigate({ to: "/login" });
  }

  return (
    <div className="flex flex-col gap-6">
      <Wordmark className="self-center" />
      <Card>
        <CardHeader>
          <CardTitle>{session.user.name}</CardTitle>
          <CardDescription>Signed in to Mage</CardDescription>
        </CardHeader>
        <CardContent>
          API: <output>{status}</output>
        </CardContent>
        <CardFooter>
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
