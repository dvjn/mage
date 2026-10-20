import { cn } from "cn";
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

export function LoginForm({
  className,
  onSignUp,
  ...props
}: React.ComponentProps<"div"> & { onSignUp: () => void }) {
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
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle>Login to your account</CardTitle>
          <CardDescription>Enter your email below to login to your account</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input id="email" name="email" type="email" placeholder="m@example.com" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input id="password" name="password" type="password" required />
              </Field>
              <Field>
                <FieldError>{error}</FieldError>
                <Button type="submit" disabled={pending}>
                  Login
                </Button>
                <FieldDescription className="text-center">
                  Don&apos;t have an account?{" "}
                  <a
                    href="#signup"
                    onClick={(event) => {
                      event.preventDefault();
                      onSignUp();
                    }}
                  >
                    Sign up
                  </a>
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
