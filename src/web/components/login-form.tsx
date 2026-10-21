import { cn } from "cn";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";

import { Button } from "@/web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { Wordmark } from "@/web/components/wordmark";
import { authClient } from "@/web/lib/auth-client";
import { sessionQuery } from "@/web/lib/queries";

export function LoginForm({ className, ...props }: React.ComponentProps<"div">) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { redirect } = useSearch({ from: "/_signed-out/login" });
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
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Wordmark className="self-center" />
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Use the email and password of your Mage account.</CardDescription>
        </CardHeader>
        <CardContent>
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
                  <Link to="/signup" search={{ redirect }}>
                    Create account
                  </Link>
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
