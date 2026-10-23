import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";

import { AuthCard } from "@/web/components/auth-frame";
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
import { sessionQuery } from "@/web/lib/queries";

export function SignupForm() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { redirect, email: invited } = useSearch({ from: "/_signed-out/signup" });
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    const { name = "", email = "", password = "" } = fields;
    if (password !== fields["confirm-password"]) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    const { error } = await authClient.signUp.email({ name, email, password });
    setPending(false);
    setError(error?.message);
    if (error) return;
    await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    await (redirect ? navigate({ href: redirect }) : navigate({ to: "/" }));
  }

  return (
    <AuthCard
      title="Create account"
      description="Your name, an email and a password are all Mage needs."
    >
      <form onSubmit={handleSubmit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input id="name" name="name" type="text" autoComplete="name" required />
          </Field>
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
              autoComplete="new-password"
              minLength={8}
              required
            />
            <FieldDescription>At least 8 characters.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="confirm-password">Confirm password</FieldLabel>
            <Input
              id="confirm-password"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              required
            />
          </Field>
          <Field>
            <FieldError>{error}</FieldError>
            <Button type="submit" disabled={pending}>
              Create account
            </Button>
            <FieldDescription className="text-center">
              Already have an account?{" "}
              <Link to="/login" search={{ redirect, email: invited }}>
                Sign in
              </Link>
            </FieldDescription>
          </Field>
        </FieldGroup>
      </form>
    </AuthCard>
  );
}
