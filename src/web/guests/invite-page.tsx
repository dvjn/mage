// An invite link opened in the browser. Signed out, it asks the person to sign in, or to create an
// account while they can, and brings them back here after; signed in, it lets them into the thread
// and opens it, or says plainly why the link no longer works.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { acceptedInviteSchema, type InviteRefusal, inviteRefusalSchema } from "@/shared/guests.ts";
import { AuthCard, AuthFrame, SignInActions, useCanSignUp } from "@/web/auth/auth-frame";
import { GoHome } from "@/web/components/page-states";
import { Spinner } from "@/web/components/ui/spinner";
import { apiClient } from "@/web/api/api-client";
import { sessionQuery } from "@/web/auth/queries";
import { sharedThreadsQuery } from "@/web/guests/queries";

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

function SignedOut({ token }: { token: string }) {
  const canSignUp = useCanSignUp();
  return (
    <AuthCard
      title="You are invited to a thread"
      description={canSignUp ? "Create an account or sign in to open it." : "Sign in to open it."}
      actions={<SignInActions back={{ redirect: `/invite/${token}` }} />}
    />
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
  return <AuthCard title={title} description={text} actions={<GoHome />} />;
}

export function InvitePage() {
  const { token } = inviteRoute.useParams();
  const session = useQuery(sessionQuery);
  return (
    <AuthFrame>
      {session.isPending ? null : session.data ? (
        <Accepting token={token} />
      ) : (
        <SignedOut token={token} />
      )}
    </AuthFrame>
  );
}
