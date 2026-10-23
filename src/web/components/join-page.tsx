// An org invite link opened in the browser. Signed out, it names the org and who invited whom, and
// asks the person to sign in, or create an account while they can, with the invited email, bringing
// them back here after; signed in as that person, it lets them into the org and opens it; signed in
// as someone else, it says whom the invite is for. A link that no longer works says why.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import {
  joinedOrgSchema,
  type JoinPreview,
  joinPreviewSchema,
  joinRefusalSchema,
} from "@/shared/orgs.ts";
import { AuthCard, AuthFrame, SignInActions, useCanSignUp } from "@/web/components/auth-frame";
import { GoHome } from "@/web/components/page-states";
import { Button } from "@/web/components/ui/button";
import { Spinner } from "@/web/components/ui/spinner";
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

function Refused({ refusal }: { refusal: Refusal }) {
  const { title, text } = REFUSALS[refusal];
  return <AuthCard title={title} description={text} actions={<GoHome />} />;
}

function invitedBy(preview: JoinPreview) {
  return preview.inviterName
    ? `${preview.inviterName} invited ${preview.email} to join.`
    : `${preview.email} is invited to join.`;
}

function SignedOut({ token, preview }: { token: string; preview: JoinPreview }) {
  const canSignUp = useCanSignUp();
  const how = canSignUp ? "Create an account or sign in" : "Sign in";
  return (
    <AuthCard
      title={`Join ${preview.orgName}`}
      description={`${invitedBy(preview)} ${how} with that email to accept.`}
      actions={<SignInActions back={{ redirect: `/join/${token}`, email: preview.email }} />}
    />
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
    <AuthCard
      title={`This invite is for ${preview.email}`}
      description={
        <>
          You are signed in with another account. Sign out, then open the link again and sign in or
          create an account with the invited email.
        </>
      }
      actions={
        <>
          <GoHome />
          <Button onClick={() => void signOut()}>Sign out</Button>
        </>
      }
    />
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
  return <AuthFrame>{body}</AuthFrame>;
}
