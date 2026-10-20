import { useQueryClient } from "@tanstack/react-query";
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
import { authClient } from "@/web/lib/auth-client";
import { sessionQuery } from "@/web/lib/queries";

export function SignupForm({
  onSignIn,
  ...props
}: React.ComponentProps<typeof Card> & { onSignIn: () => void }) {
  const queryClient = useQueryClient();
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
    if (!error) await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
  }

  return (
    <Card {...props}>
      <CardHeader>
        <CardTitle>Create an account</CardTitle>
        <CardDescription>Enter your information below to create your account</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="name">Full Name</FieldLabel>
              <Input id="name" name="name" type="text" placeholder="John Doe" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input id="email" name="email" type="email" placeholder="m@example.com" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input id="password" name="password" type="password" minLength={8} required />
              <FieldDescription>Must be at least 8 characters long.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="confirm-password">Confirm Password</FieldLabel>
              <Input id="confirm-password" name="confirm-password" type="password" required />
              <FieldDescription>Please confirm your password.</FieldDescription>
            </Field>
            <FieldGroup>
              <Field>
                <FieldError>{error}</FieldError>
                <Button type="submit" disabled={pending}>
                  Create Account
                </Button>
                <FieldDescription className="px-6 text-center">
                  Already have an account?{" "}
                  <a
                    href="#login"
                    onClick={(event) => {
                      event.preventDefault();
                      onSignIn();
                    }}
                  >
                    Sign in
                  </a>
                </FieldDescription>
              </Field>
            </FieldGroup>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
