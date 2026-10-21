// An invite link opened in the browser. Signed out, it asks the person to create an account or sign
// in, and brings them back here after; signed in, it lets them into the thread and opens it, or
// says plainly why the link no longer works.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { acceptedInviteSchema, type InviteRefusal, inviteRefusalSchema } from "@/shared/guests.ts";
import { Button } from "@/web/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Spinner } from "@/web/components/ui/spinner";
import { Wordmark } from "@/web/components/wordmark";
import { apiClient } from "@/web/lib/api-client";
import { sessionQuery, sharedThreadsQuery } from "@/web/lib/queries";

const inviteRoute = getRouteApi("/invite/$token");

const REFUSALS: Record<InviteRefusal["reason"], { title: string; text: string }> = {
  used: {
    title: "This link was already used",
    text: "Each invite link works once. Ask whoever shared the thread for a new one.",
  },
  expired: {
    title: "This link has expired",
    text: "Invite links work for 7 days. Ask whoever shared the thread for a new one.",
  },
  revoked: {
    title: "This link was revoked",
    text: "Whoever shared the thread took this link back. Ask them for a new one if you need it.",
  },
  not_found: {
    title: "This link does not work",
    text: "Check that the whole link was copied, or ask whoever shared the thread for a new one.",
  },
};

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Wordmark className="self-center" />
        {children}
      </div>
    </main>
  );
}

function SignedOut({ token }: { token: string }) {
  const back = { redirect: `/invite/${token}` };
  return (
    <Card>
      <CardHeader>
        <CardTitle>You are invited to a thread</CardTitle>
        <CardDescription>Create an account or sign in to open it.</CardDescription>
      </CardHeader>
      <CardFooter className="flex gap-2">
        <Button render={<Link to="/signup" search={back} />} nativeButton={false}>
          Create account
        </Button>
        <Button variant="outline" render={<Link to="/login" search={back} />} nativeButton={false}>
          Sign in
        </Button>
      </CardFooter>
    </Card>
  );
}

function Accepting({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [refusal, setRefusal] = useState<InviteRefusal["reason"] | "failed">();
  // Accepting runs once, however often the page renders.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const res = await apiClient.v1.invites.accept.$post({ json: { token } });
      if (!res.ok) {
        const body = inviteRefusalSchema.safeParse(await res.json().catch(() => null));
        setRefusal(body.success ? body.data.reason : "failed");
        return;
      }
      const { threadId } = acceptedInviteSchema.parse(await res.json());
      await queryClient.invalidateQueries({ queryKey: sharedThreadsQuery.queryKey });
      await navigate({ to: "/t/$threadId", params: { threadId }, replace: true });
    })();
  }, [token, queryClient, navigate]);

  if (!refusal) {
    return (
      <div role="status" className="flex items-center justify-center gap-2 text-muted-foreground">
        <Spinner aria-hidden />
        <span>Opening the thread…</span>
      </div>
    );
  }
  const { title, text } =
    refusal === "failed"
      ? { title: "Something went wrong", text: "The link could not be opened. Try again." }
      : REFUSALS[refusal];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{text}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button variant="outline" render={<Link to="/" />} nativeButton={false}>
          Go home
        </Button>
      </CardFooter>
    </Card>
  );
}

export function InvitePage() {
  const { token } = inviteRoute.useParams();
  const session = useQuery(sessionQuery);
  return (
    <Frame>
      {session.isPending ? null : session.data ? (
        <Accepting token={token} />
      ) : (
        <SignedOut token={token} />
      )}
    </Frame>
  );
}
