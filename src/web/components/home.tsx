import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";

import { Button } from "@/web/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Wordmark } from "@/web/components/wordmark";
import { authClient } from "@/web/lib/auth-client";
import { connectionsQuery, meQuery, sessionQuery } from "@/web/lib/queries";

const homeRoute = getRouteApi("/");

export function Home() {
  const { session } = homeRoute.useRouteContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery(meQuery);

  async function signOut() {
    await authClient.signOut();
    queryClient.removeQueries({ queryKey: meQuery.queryKey });
    queryClient.removeQueries({ queryKey: connectionsQuery.queryKey });
    await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    await navigate({ to: "/login" });
  }

  return (
    <div className="flex flex-col gap-6">
      <Wordmark className="self-center" />
      <Card>
        <CardHeader>
          <CardTitle>{session.user.name}</CardTitle>
          <CardDescription>
            {me.data ? `Personal org: ${me.data.org.name}` : "Signed in to Mage"}
          </CardDescription>
        </CardHeader>
        <CardFooter className="justify-between">
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
          <Link to="/settings" className="text-sm underline underline-offset-4">
            Settings
          </Link>
        </CardFooter>
      </Card>
    </div>
  );
}
