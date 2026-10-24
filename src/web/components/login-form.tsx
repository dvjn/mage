// Signing in: at the identity provider when there is one, and otherwise with an email and password,
// with a way to create an account. A sign-in the provider sent back says what went wrong.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";

import { AuthCard, ContinueWith } from "@/web/components/auth-frame";
import { Button } from "@/web/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { authClient } from "@/web/lib/auth-client";
import { sessionQuery, signInOptionsQuery } from "@/web/lib/queries";

export function LoginForm() {
  const { redirect, email: invited, error: refused } = useSearch({ from: "/_signed-out/login" });
  const options = useQuery(signInOptionsQuery).data;
  if (!options) return <AuthCard title="Sign in" />;

  const oidc = options.oidc;
  if (!oidc) {
    return (
      <AuthCard title="Sign in" description="Use the email and password of your Mage account.">
        <PasswordForm redirect={redirect} invited={invited} />
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Sign in" description={`Use your ${oidc.name} account.`}>
      <Field>
        <ContinueWith name={oidc.name} redirect={redirect} primary />
        {refused && (
          <FieldError>
            Signing in with {oidc.name} did not work ({refused.replaceAll("_", " ")}).
          </FieldError>
        )}
      </Field>
    </AuthCard>
  );
}

function PasswordForm({ redirect, invited }: { redirect?: string; invited?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { email = "", password = "" } = Object.fromEntries(
      new FormData(event.currentTarget),
    ) as Record<string, string>;
    setPending(true);
    const { error } = await authClient.signIn.email({ email, password });
    setPending(false);
    setError(error?.message);
    if (error) return;
    await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    await (redirect ? navigate({ href: redirect }) : navigate({ to: "/" }));
  }

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            defaultValue={invited}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <Field>
          <FieldError>{error}</FieldError>
          <Button type="submit" disabled={pending}>
            Sign in
          </Button>
          <FieldDescription className="text-center">
            New to Mage?{" "}
            <Link to="/signup" search={{ redirect, email: invited }}>
              Create account
            </Link>
          </FieldDescription>
        </Field>
      </FieldGroup>
    </form>
  );
}
