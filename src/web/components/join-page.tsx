// An org invite link opened in the browser. Signed out, it names the org and who invited whom, and
// asks the person to create an account or sign in with the invited email, bringing them back here
// after; signed in as that person, it lets them into the org and opens it; signed in as someone
// else, it says whom the invite is for. A link that no longer works says why.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import {
  joinedOrgSchema,
  type JoinPreview,
  joinPreviewSchema,
  joinRefusalSchema,
} from "@/shared/orgs.ts";
import { GoHome } from "@/web/components/page-states";
import { Button } from "@/web/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Spinner } from "@/web/components/ui/spinner";
import { Wordmark } from "@/web/components/wordmark";
import { apiClient } from "@/web/lib/api-client";
import { authClient } from "@/web/lib/auth-client";
import { switchOrg } from "@/web/lib/org-tab";
import { forgetCache } from "@/web/lib/query-cache";
import { sessionQuery } from "@/web/lib/queries";

const joinRoute = getRouteApi("/join/$token");

type Refusal = "used" | "expired" | "revoked" | "not_found" | "failed";

const REFUSALS: Record<Refusal, { title: string; text: string }> = {
  used: {
    title: "This invite was already used",
    text: "Each invite link works once. Ask an owner of the organization for a new one.",
  },
  expired: {
    title: "This invite has expired",
    text: "Invite links work for 7 days. Ask an owner of the organization for a new one.",
  },
  revoked: {
    title: "This invite was revoked",
    text: "An owner of the organization took this link back. Ask them for a new one if you need it.",
  },
  not_found: {
    title: "This invite does not work",
    text: "Check that the whole link was copied, or ask an owner of the organization for a new one.",
  },
  failed: { title: "Something went wrong", text: "The invite could not be opened. Try again." },
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

function Refused({ refusal }: { refusal: Refusal }) {
  const { title, text } = REFUSALS[refusal];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{text}</CardDescription>
      </CardHeader>
      <CardFooter>
        <GoHome />
      </CardFooter>
    </Card>
  );
}

function invitedBy(preview: JoinPreview) {
  return preview.inviterName
    ? `${preview.inviterName} invited ${preview.email} to join.`
    : `${preview.email} is invited to join.`;
}

function SignedOut({ token, preview }: { token: string; preview: JoinPreview }) {
  const back = { redirect: `/join/${token}`, email: preview.email };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Join {preview.orgName}</CardTitle>
        <CardDescription>
          {invitedBy(preview)} Create an account or sign in with that email to accept.
        </CardDescription>
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

// Signed in as someone the invite is not for.
function WrongAccount({ preview }: { preview: JoinPreview }) {
  const queryClient = useQueryClient();

  async function signOut() {
    await authClient.signOut();
    await forgetCache(queryClient);
    await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>This invite is for {preview.email}</CardTitle>
        <CardDescription>
          You are signed in with another account. Sign out, then open the link again and sign in or
          create an account with the invited email.
        </CardDescription>
      </CardHeader>
      <CardFooter className="flex gap-2">
        <GoHome />
        <Button onClick={() => void signOut()}>Sign out</Button>
      </CardFooter>
    </Card>
  );
}

function Joining({ token }: { token: string }) {
  const [refusal, setRefusal] = useState<Refusal>();
  // Joining runs once, however often the page renders.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const res = await apiClient.v1["org-invites"].accept.$post({ json: { token } });
      if (!res.ok) {
        const body = joinRefusalSchema.safeParse(await res.json().catch(() => null));
        const reason = body.success ? body.data.reason : "failed";
        setRefusal(reason === "wrong_account" ? "failed" : reason);
        return;
      }
      const { orgId, spaceId } = joinedOrgSchema.parse(await res.json());
      switchOrg(orgId, spaceId ? `/s/${spaceId}` : "/");
    })();
  }, [token]);

  if (refusal) return <Refused refusal={refusal} />;
  return (
    <div role="status" className="flex items-center justify-center gap-2 text-muted-foreground">
      <Spinner aria-hidden />
      <span>Joining…</span>
    </div>
  );
}

export function JoinPage() {
  const { token } = joinRoute.useParams();
  const session = useQuery(sessionQuery);
  const preview = useQuery({
    queryKey: ["join", token, session.data?.user.id ?? null],
    enabled: !session.isPending,
    retry: false,
    queryFn: async () => {
      const res = await fetch(`/api/org-invites/${encodeURIComponent(token)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("could not read the invite");
      return joinPreviewSchema.parse(await res.json());
    },
  });

  let body: React.ReactNode = null;
  if (preview.error) body = <Refused refusal="failed" />;
  else if (preview.data === null) body = <Refused refusal="not_found" />;
  else if (preview.data) {
    const found = preview.data;
    if (session.data && found.member) body = <Joining token={token} />;
    else if (found.status !== "ok") body = <Refused refusal={found.status} />;
    else if (!session.data) body = <SignedOut token={token} preview={found} />;
    else if (!found.yours) body = <WrongAccount preview={found} />;
    else body = <Joining token={token} />;
  }
  return <Frame>{body}</Frame>;
}
