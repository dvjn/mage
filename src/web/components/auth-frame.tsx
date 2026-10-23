// The one frame of the pages around getting in: signing in or up, opening an invite and a thread
// whose access ended. The wordmark over one card, centred: its title, what it says, then its form
// or its actions. On its own it fills the screen; inside the app, the space beside the sidebar.
// Pages that ask the person to get in first offer the same ways in, the identity provider first
// when there is one.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { type ReactNode, useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import { Button } from "@/web/components/ui/button";
import { Wordmark } from "@/web/components/wordmark";
import { authClient } from "@/web/lib/auth-client";
import { signInOptionsQuery } from "@/web/lib/queries";

export function AuthFrame({ children, inApp = false }: { children: ReactNode; inApp?: boolean }) {
  const Root = inApp ? "div" : "main";
  return (
    <Root className={cn("flex items-center justify-center p-6", inApp ? "flex-1" : "min-h-svh")}>
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Wordmark className="self-center" />
        {children}
      </div>
    </Root>
  );
}

export function AuthCard({
  title,
  description,
  children,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  // A form.
  children?: ReactNode;
  // Buttons, side by side.
  actions?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      {children && <CardContent>{children}</CardContent>}
      {actions && <CardFooter className="flex flex-wrap gap-2">{actions}</CardFooter>}
    </Card>
  );
}

// Whether people can create an account here with a password.
export function useCanSignUp() {
  return useQuery(signInOptionsQuery).data?.password === "everyone";
}

// Signs in at the identity provider, which sends the person on to `redirect`, or back to sign-in
// saying what went wrong.
export function ContinueWith({
  name,
  redirect,
  primary = false,
}: {
  name: string;
  redirect?: string;
  primary?: boolean;
}) {
  const [pending, setPending] = useState(false);

  async function start() {
    setPending(true);
    const back = new URLSearchParams(redirect ? { redirect } : {});
    const { error } = await authClient.signIn.social({
      provider: "oidc",
      callbackURL: redirect ?? "/",
      errorCallbackURL: `/login${back.size ? `?${back}` : ""}`,
    });
    // On success the page is already on its way to the provider.
    if (error) setPending(false);
  }

  return (
    <Button
      variant={primary ? "default" : "outline"}
      className="w-full"
      disabled={pending}
      onClick={() => void start()}
    >
      Continue with {name}
    </Button>
  );
}

// The ways in from a page that sends the person back to it once they are in: the identity
// provider, creating an account while password sign-up is open, and signing in with a password.
export function SignInActions({ back }: { back: { redirect: string; email?: string } }) {
  const options = useQuery(signInOptionsQuery).data;
  const canSignUp = options?.password === "everyone";
  return (
    <>
      {options?.oidc && <ContinueWith name={options.oidc.name} redirect={back.redirect} primary />}
      {canSignUp && (
        <Button
          variant={options?.oidc ? "outline" : "default"}
          render={<Link to="/signup" search={back} />}
          nativeButton={false}
        >
          Create account
        </Button>
      )}
      {options?.password !== "off" && (
        <Button
          variant={canSignUp || options?.oidc ? "outline" : "default"}
          render={<Link to="/login" search={back} />}
          nativeButton={false}
        >
          {options?.oidc ? "Sign in with password" : "Sign in"}
        </Button>
      )}
    </>
  );
}
